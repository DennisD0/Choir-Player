import { promises as fs } from "fs";
import { NextRequest, NextResponse } from "next/server";
import { getJob } from "@/lib/jobs";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ jobId: string }> }
) {
  const { jobId } = await params;
  const job = getJob(jobId);

  if (!job || job.status !== "done" || !job.resultPath) {
    return NextResponse.json({ error: "Result not available" }, { status: 404 });
  }

  const data = await fs.readFile(job.resultPath);

  return new NextResponse(data, {
    headers: {
      "Content-Type": "application/vnd.recordare.musicxml",
      "Content-Disposition": 'inline; filename="score.mxl"',
    },
  });
}
