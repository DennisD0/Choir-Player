import { randomUUID } from "crypto";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { NextRequest, NextResponse } from "next/server";
import {
  isAudiverisAvailable,
  isReliableNoteTranscription,
  runAudiveris,
  scoreMusicXmlArchive,
} from "@/lib/audiveris";
import { createJob, updateJob } from "@/lib/jobs";
import { isImageFile, preprocessImageVariants } from "@/lib/image-preprocess";
import { enqueueOmr } from "@/lib/omr-queue";
import { getHymnPreset, hymnNumberFromFilename } from "@/lib/hymn-presets";
import {
  checkIpRate,
  clientIp,
  releaseSlot,
  tryReserveSlot,
} from "@/lib/rate-limit";

// Use a writable temp dir: serverless hosts (Vercel) mount the project read-only
// and only allow writes under the OS temp dir. Jobs store absolute paths, so the
// status/result routes don't depend on this location.
const DATA_DIR = path.join(os.tmpdir(), "omr-data");

export async function POST(req: NextRequest) {
  const formData = await req.formData();
  const file = formData.get("file");

  if (!(file instanceof File)) {
    return NextResponse.json({ error: "No file uploaded" }, { status: 400 });
  }

  // Abuse protection: the service is public (--allow-unauthenticated), so cap how
  // fast any one visitor can submit uploads before doing any work.
  const ipRate = checkIpRate(clientIp(req.headers), Date.now());
  if (!ipRate.ok) {
    return NextResponse.json(
      { error: ipRate.reason },
      { status: 429, headers: { "Retry-After": String(ipRate.retryAfter ?? 60) } }
    );
  }

  // For a hymn with a user-supplied canonical score, prefer that score over a
  // low-confidence photo transcription. The cropper prefixes the inferred
  // hymn number to the upload filename. (Cheap, no disk I/O — decide before we
  // write anything or check for the recognition engine.)
  const hymnNumber = hymnNumberFromFilename(file.name);
  const preset = hymnNumber ? getHymnPreset(hymnNumber) : null;

  // Photo/PDF recognition needs the bundled Audiveris engine, which only exists
  // in the desktop build. On the hosted site it's absent, so fail clearly here
  // instead of crashing on a read-only filesystem or a missing binary.
  if (!preset && !isAudiverisAvailable()) {
    return NextResponse.json(
      {
        error:
          "Photo and PDF recognition isn't available on the hosted site — it " +
          "needs the desktop recognition engine. Upload a MusicXML " +
          "(.mxl / .xml / .musicxml) file here, or use the desktop app for photos.",
      },
      { status: 503 }
    );
  }

  const jobId = randomUUID();
  const jobDir = path.join(DATA_DIR, jobId);
  const inputDir = path.join(jobDir, "input");
  const outputDir = path.join(jobDir, "output");
  await fs.mkdir(inputDir, { recursive: true });
  await fs.mkdir(outputDir, { recursive: true });

  const originalBuffer = Buffer.from(await file.arrayBuffer());
  const originalExt = path.extname(file.name).toLowerCase() || ".bin";
  const originalPath = path.join(inputDir, `score-original${originalExt}`);
  await fs.writeFile(originalPath, originalBuffer);

  if (preset) {
    const resultPath = path.join(outputDir, `hymn-${hymnNumber}.mxl`);
    await fs.writeFile(resultPath, preset);
    createJob({
      id: jobId,
      status: "done",
      message: `Loaded verified hymn ${hymnNumber} score`,
      inputPath: originalPath,
      outputDir,
      resultPath,
      createdAt: Date.now(),
    });
    return NextResponse.json({ jobId });
  }

  // Recognition is serialized and slow (minutes each). Reject once the queue is
  // full rather than letting it be stuffed with more work than it can clear.
  const slot = tryReserveSlot();
  if (!slot.ok) {
    return NextResponse.json(
      { error: slot.reason },
      { status: 429, headers: { "Retry-After": String(slot.retryAfter ?? 30) } }
    );
  }

  // Photos/scans try the cleaned image first, but retain the original crop as
  // a fallback because aggressive enhancement can trigger Audiveris bugs.
  const attempts: Array<{ path: string; label: string }> = [];
  if (isImageFile(file.name)) {
    const variants = await preprocessImageVariants(originalBuffer);
    for (let index = 0; index < variants.length; index++) {
      const variantPath = path.join(inputDir, `score-notes-${index + 1}.png`);
      await fs.writeFile(variantPath, variants[index].buffer);
      attempts.push({ path: variantPath, label: variants[index].label });
    }
  }
  attempts.push({ path: originalPath, label: "original image" });
  const inputPath = attempts[0].path;

  createJob({
    id: jobId,
    status: "pending",
    message: "Queued for note recognition...",
    inputPath,
    outputDir,
    createdAt: Date.now(),
  });

  // Audiveris is memory-heavy. Queue jobs in the background while the client
  // polls /api/omr/status/[jobId]. Free the queue slot once the job settles,
  // however it settles, so the global in-flight cap stays accurate.
  void enqueueOmr(() => processJob(jobId, attempts, outputDir)).finally(
    releaseSlot
  );

  return NextResponse.json({ jobId });
}

async function processJob(
  jobId: string,
  attempts: Array<{ path: string; label: string }>,
  outputDir: string
) {
  updateJob(jobId, {
    status: "processing",
    message: "Running OMR (this can take a minute or two)...",
  });

  const errors: string[] = [];
  const results: Array<{ path: string; label: string; score: number }> = [];
  for (let index = 0; index < attempts.length; index++) {
    const attempt = attempts[index];
    const attemptOutput = path.join(outputDir, `attempt-${index + 1}`);
    await fs.mkdir(attemptOutput, { recursive: true });
    if (index > 0) {
      updateJob(jobId, {
        message: `Retrying OMR with the ${attempt.label}...`,
      });
    }
    try {
      const resultPath = await runAudiveris(
        attempt.path,
        attemptOutput,
        createProgressReporter(jobId)
      );
      const quality = await scoreMusicXmlArchive(resultPath);
      if (isReliableNoteTranscription(quality)) {
        results.push({ path: resultPath, label: attempt.label, score: quality.score });
        // The first attempt is the cleaned-up image, which is the best input.
        // If it already yields reliable notation, skip the slower fallback
        // pass(es) — each one is a full multi-minute OMR run on dense pages.
        break;
      } else {
        errors.push(
          `${attempt.label}: incomplete note transcription ` +
            `(${quality.pitchedNotes} notes, ${quality.measureCount} measures` +
            `${quality.hasTimeSignature ? "" : ", missing time signature"}` +
            `, part balance ${Math.round(quality.partNoteBalance * 100)}%)`
        );
      }
    } catch (error) {
      errors.push(
        `${attempt.label}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  if (results.length > 0) {
    results.sort((a, b) => b.score - a.score);
    updateJob(jobId, {
      status: "done",
      resultPath: results[0].path,
      message: `Done — selected ${results[0].label}`,
    });
    return;
  }

  updateJob(jobId, {
    status: "error",
    message: "Recognition failed",
    error: errors.join("\n\n"),
  });
}

/** Turn Audiveris's multi-page log into useful progress for the polling UI. */
function createProgressReporter(jobId: string): (chunk: string) => void {
  let buffered = "";
  let totalPages: number | null = null;
  let currentPage = 0;

  return (chunk) => {
    buffered += chunk;
    const lines = buffered.split(/\r?\n/);
    buffered = lines.pop() ?? "";

    for (const line of lines) {
      const totalMatch = line.match(/\|\s+(\d+)\s+sheets?\s+in\b/i);
      if (totalMatch) totalPages = Number(totalMatch[1]);

      const pageMatch = line.match(/\[[^\]]*#(\d+)\].*StepMonitoring/i);
      const singlePageStep = totalPages === 1 && /StepMonitoring/i.test(line);
      if (!pageMatch && !singlePageStep) continue;
      const page = pageMatch ? Number(pageMatch[1]) : 1;
      if (!Number.isFinite(page) || page <= currentPage) continue;
      currentPage = page;
      updateJob(jobId, {
        message: totalPages
          ? `Recognizing page ${page} of ${totalPages}...`
          : `Recognizing page ${page}...`,
      });
    }
  };
}
