import { spawn } from "child_process";
import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { NextRequest, NextResponse } from "next/server";
import { checkIpRate, clientIp } from "@/lib/rate-limit";
import { toPdfPage, HYMNAL_MAX, type HymnalEdition } from "@/lib/hymnal-map";

// Path to the combined 찬송가 + 은혜찬송 PDF.
// On Cloud Run this is baked into the image at /app/hymnal/hymnal.pdf.
// Override with HYMNAL_PDF env var for local dev.
const HYMNAL_PDF =
  process.env.HYMNAL_PDF ?? path.join(process.cwd(), "hymnal", "hymnal.pdf");

const COLLECTION_TO_EDITION: Record<string, HymnalEdition> = {
  chansonggah: "찬송가",
  gracesong: "은혜찬송",
};

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ collection: string; number: string }> }
) {
  const { collection, number } = await params;

  const edition = COLLECTION_TO_EDITION[collection];
  if (!edition) {
    return NextResponse.json({ error: "Unknown collection" }, { status: 400 });
  }

  const n = parseInt(number, 10);
  const max = HYMNAL_MAX[edition];
  if (!Number.isFinite(n) || n < 1 || n > max) {
    return NextResponse.json(
      { error: `Hymn number must be 1–${max} for ${edition}` },
      { status: 400 }
    );
  }

  const ipRate = checkIpRate(clientIp(req.headers), Date.now());
  if (!ipRate.ok) {
    return NextResponse.json(
      { error: ipRate.reason },
      { status: 429, headers: { "Retry-After": String(ipRate.retryAfter ?? 60) } }
    );
  }

  const pdfPage = toPdfPage(n, edition);

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "hymn-"));
  const outPrefix = path.join(tmpDir, "p");
  try {
    await runPdftoppm(HYMNAL_PDF, pdfPage, outPrefix);

    const files = await fs.readdir(tmpDir);
    const pngFile = files.find((f) => f.endsWith(".png"));
    if (!pngFile) throw new Error("pdftoppm did not produce a PNG");

    const pngBuffer = await fs.readFile(path.join(tmpDir, pngFile));
    const padded = String(n).padStart(3, "0");
    return new NextResponse(pngBuffer, {
      status: 200,
      headers: {
        "Content-Type": "image/png",
        "Content-Disposition": `attachment; filename="${padded}장.png"`,
        "Cache-Control": "public, max-age=86400",
      },
    });
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

function runPdftoppm(
  pdfPath: string,
  page: number,
  outPrefix: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    // 200 DPI → ~1654×2339 px for an A4 page ≈ 3.9 MP, well under Audiveris's
    // 20 MP hard limit while giving enough detail for OMR.
    const proc = spawn("pdftoppm", [
      "-f", String(page),
      "-l", String(page),
      "-r", "200",
      "-png",
      pdfPath,
      outPrefix,
    ]);

    let stderr = "";
    proc.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    proc.on("error", (err) =>
      reject(new Error(`pdftoppm not available: ${err.message}`))
    );
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`pdftoppm exited ${code}: ${stderr.trim()}`));
    });
  });
}
