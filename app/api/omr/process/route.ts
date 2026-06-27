import { randomUUID } from "crypto";
import { promises as fs } from "fs";
import path from "path";
import { NextRequest, NextResponse } from "next/server";
import {
  isReliableNoteTranscription,
  runAudiveris,
  scoreMusicXmlArchive,
} from "@/lib/audiveris";
import { createJob, updateJob } from "@/lib/jobs";
import { isImageFile, preprocessImageVariants } from "@/lib/image-preprocess";
import { enqueueOmr } from "@/lib/omr-queue";
import { getHymnPreset, hymnNumberFromFilename } from "@/lib/hymn-presets";

const DATA_DIR = path.join(process.cwd(), "omr-data");

export async function POST(req: NextRequest) {
  const formData = await req.formData();
  const file = formData.get("file");

  if (!(file instanceof File)) {
    return NextResponse.json({ error: "No file uploaded" }, { status: 400 });
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

  // For a hymn with a user-supplied canonical score, prefer that score over a
  // low-confidence photo transcription. The cropper prefixes the inferred
  // hymn number to the upload filename.
  const hymnNumber = hymnNumberFromFilename(file.name);
  const preset = hymnNumber ? getHymnPreset(hymnNumber) : null;
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
    inputPath,
    outputDir,
    createdAt: Date.now(),
  });

  // Audiveris is memory-heavy. Queue jobs in the background while the client
  // polls /api/omr/status/[jobId].
  void enqueueOmr(() => processJob(jobId, attempts, outputDir));

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
      const resultPath = await runAudiveris(attempt.path, attemptOutput);
      const quality = await scoreMusicXmlArchive(resultPath);
      if (isReliableNoteTranscription(quality)) {
        results.push({ path: resultPath, label: attempt.label, score: quality.score });
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
