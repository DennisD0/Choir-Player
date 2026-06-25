import { spawn } from "child_process";
import { promises as fs } from "fs";
import path from "path";

const AUDIVERIS_EXE = path.join(
  process.cwd(),
  "tools",
  "audiveris",
  "Audiveris",
  "Audiveris.exe"
);

export class AudiverisError extends Error {}

/**
 * Find the largest file with the given suffix under `dir`. Audiveris sometimes
 * splits one page into several "movement" exports (score.mvt1.mxl, …); the
 * largest is the most complete, so prefer it over an arbitrary first match.
 */
async function findFile(dir: string, suffix: string): Promise<string | null> {
  let best: string | null = null;
  let bestSize = -1;
  const walk = async (d: string): Promise<void> => {
    const entries = await fs.readdir(d, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(d, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.name.toLowerCase().endsWith(suffix)) {
        const { size } = await fs.stat(fullPath);
        if (size > bestSize) {
          bestSize = size;
          best = fullPath;
        }
      }
    }
  };
  await walk(dir);
  return best;
}

/**
 * Runs Audiveris OMR on the given input file (image or PDF) and returns the
 * path to the generated MusicXML (.mxl) file.
 */
export function runAudiveris(
  inputPath: string,
  outputDir: string,
  onProgress?: (line: string) => void
): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      AUDIVERIS_EXE,
      ["-batch", "-export", "-output", outputDir, "--", inputPath],
      { windowsHide: true }
    );

    let stderrTail = "";
    proc.stdout?.on("data", (chunk: Buffer) => onProgress?.(chunk.toString()));
    proc.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderrTail = (stderrTail + text).slice(-2000);
      onProgress?.(text);
    });

    proc.on("error", (err) => {
      reject(new AudiverisError(`Failed to start Audiveris: ${err.message}`));
    });

    proc.on("close", async (code) => {
      if (code !== 0) {
        reject(
          new AudiverisError(`Audiveris exited with code ${code}: ${stderrTail}`)
        );
        return;
      }
      try {
        const mxl = await findFile(outputDir, ".mxl");
        if (!mxl) {
          reject(new AudiverisError("Audiveris did not produce a .mxl output file"));
          return;
        }
        resolve(mxl);
      } catch (err) {
        reject(err);
      }
    });
  });
}
