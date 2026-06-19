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

async function findFile(dir: string, suffix: string): Promise<string | null> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = await findFile(fullPath, suffix);
      if (found) return found;
    } else if (entry.name.toLowerCase().endsWith(suffix)) {
      return fullPath;
    }
  }
  return null;
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
