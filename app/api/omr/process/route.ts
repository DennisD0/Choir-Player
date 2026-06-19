import { randomUUID } from "crypto";
import { promises as fs } from "fs";
import path from "path";
import { NextRequest, NextResponse } from "next/server";
import { runAudiveris } from "@/lib/audiveris";
import { createJob, updateJob } from "@/lib/jobs";

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

  const ext = path.extname(file.name) || "";
  const inputPath = path.join(inputDir, `score${ext}`);
  await fs.writeFile(inputPath, Buffer.from(await file.arrayBuffer()));

  createJob({
    id: jobId,
    status: "pending",
    inputPath,
    outputDir,
    createdAt: Date.now(),
  });

  // Run OMR in the background; the client polls /api/omr/status/[jobId].
  void processJob(jobId, inputPath, outputDir);

  return NextResponse.json({ jobId });
}

async function processJob(jobId: string, inputPath: string, outputDir: string) {
  updateJob(jobId, {
    status: "processing",
    message: "Running OMR (this can take a minute or two)...",
  });
  try {
    const resultPath = await runAudiveris(inputPath, outputDir);
    updateJob(jobId, { status: "done", resultPath, message: "Done" });
  } catch (err) {
    updateJob(jobId, {
      status: "error",
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
