import { spawn } from "child_process";
import { promises as fs, existsSync } from "fs";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import JSZip from "jszip";
import path from "path";

const AUDIVERIS_EXE = path.join(
  process.cwd(),
  "tools",
  "audiveris",
  "Audiveris",
  "Audiveris.exe"
);

// Tesseract language data for Audiveris's OCR (titles, tempo, lyrics). Drop
// eng.traineddata / kor.traineddata (full tessdata, with the legacy engine
// Audiveris needs) here; if absent, Audiveris just runs without text OCR.
const TESSDATA_DIR = path.join(
  process.cwd(),
  "tools",
  "audiveris",
  "tessdata"
);

export class AudiverisError extends Error {}

export interface MusicXmlQuality {
  score: number;
  pitchedNotes: number;
  partCount: number;
  measureCount: number;
  partNoteBalance: number;
  partDurationBalance: number;
  hasKeySignature: boolean;
  hasTimeSignature: boolean;
}

export function isReliableNoteTranscription(quality: MusicXmlQuality): boolean {
  const balancedScore =
    quality.score >= 480 &&
    quality.pitchedNotes >= 20 &&
    quality.partCount >= 1 &&
    quality.partCount <= 4 &&
    quality.measureCount >= 4 &&
    quality.partNoteBalance >= 0.65 &&
    quality.partDurationBalance >= 0.6 &&
    quality.hasTimeSignature;

  // Photographed hymnals often omit a machine-readable time signature or are
  // split by Audiveris into uneven voice parts. A large export with many notes
  // and measures is still substantially more useful than a tiny, perfectly
  // balanced fragment. Keep strict structural limits while allowing that
  // high-coverage result through.
  const substantialCoverage =
    quality.score >= 350 &&
    quality.pitchedNotes >= 100 &&
    quality.partCount >= 1 &&
    quality.partCount <= 4 &&
    quality.measureCount >= 6;

  return balancedScore || substantialCoverage;
}

/**
 * Compare two valid exports by how much playable notation they contain.
 * Audiveris can split one photographed page into several movement files. A
 * short fragment with a time signature can have a higher metadata-weighted
 * quality score than the main movement, so coverage must be the first key.
 */
export function compareMusicXmlCoverage(
  left: MusicXmlQuality,
  right: MusicXmlQuality
): number {
  return (
    left.pitchedNotes - right.pitchedNotes ||
    left.measureCount - right.measureCount ||
    left.score - right.score
  );
}

/**
 * Find the largest file with the given suffix under `dir`. Audiveris sometimes
 * splits one page into several "movement" exports (score.mvt1.mxl, …); the
 * largest is the most complete, so prefer it over an arbitrary first match.
 */
async function findFiles(dir: string, suffix: string): Promise<string[]> {
  const matches: Array<{ path: string; size: number }> = [];
  const walk = async (d: string): Promise<void> => {
    const entries = await fs.readdir(d, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(d, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.name.toLowerCase().endsWith(suffix)) {
        const { size } = await fs.stat(fullPath);
        matches.push({ path: fullPath, size });
      }
    }
  };
  await walk(dir);
  return matches.sort((a, b) => b.size - a.size).map((match) => match.path);
}

function parsePlayableMusicXml(xml: string, source: string): Document {
  const errors: string[] = [];
  const parser = new DOMParser({
    errorHandler: {
      warning: (message) => errors.push(message),
      error: (message) => errors.push(message),
      fatalError: (message) => errors.push(message),
    },
  });
  const document = parser.parseFromString(xml, "application/xml");
  const root = document.documentElement?.localName;
  if (errors.length || (root !== "score-partwise" && root !== "score-timewise")) {
    throw new AudiverisError(`Invalid MusicXML in ${source}: ${errors[0] ?? "bad root"}`);
  }
  if (
    document.getElementsByTagName("note").length === 0 ||
    document.getElementsByTagName("duration").length === 0 ||
    document.getElementsByTagName("pitch").length === 0
  ) {
    throw new AudiverisError(`MusicXML in ${source} contains no playable notes`);
  }
  return document;
}

function qualityForDocument(document: Document): MusicXmlQuality {
  const parts = Array.from(document.getElementsByTagName("part"));
  const measureCounts: number[] = [];
  const noteCounts: number[] = [];
  const durationTotals: number[] = [];

  for (const part of parts) {
    measureCounts.push(part.getElementsByTagName("measure").length);
    const pitched = Array.from(part.getElementsByTagName("note")).filter(
      (note) => note.getElementsByTagName("pitch").length > 0
    );
    noteCounts.push(pitched.length);
    durationTotals.push(
      pitched.reduce((sum, note) => {
        const value = Number(note.getElementsByTagName("duration")[0]?.textContent ?? 0);
        return sum + (Number.isFinite(value) ? value : 0);
      }, 0)
    );
  }

  const pitchedNotes = noteCounts.reduce((sum, value) => sum + value, 0);
  const measureCount = Math.max(0, ...measureCounts);
  const partCount = parts.length;
  const balanceRatio = (values: number[]): number => {
    if (values.length <= 1) return 1;
    const maximum = Math.max(...values);
    return maximum > 0 ? Math.min(...values) / maximum : 0;
  };
  const partNoteBalance = balanceRatio(noteCounts);
  const partDurationBalance = balanceRatio(durationTotals);
  const hasKeySignature = document.getElementsByTagName("fifths").length > 0;
  const hasTimeSignature =
    document.getElementsByTagName("beats").length > 0 &&
    document.getElementsByTagName("beat-type").length > 0;
  const score =
    Math.min(pitchedNotes, 300) +
    Math.min(measureCount, 30) * 2 +
    (partCount >= 1 && partCount <= 4
      ? 50
      : Math.max(0, 50 - Math.abs(partCount - 2) * 15)) +
    balanceRatio(measureCounts) * 100 +
    partNoteBalance * 100 +
    partDurationBalance * 80 +
    (hasKeySignature ? 30 : 0) +
    (hasTimeSignature ? 60 : 0);

  return {
    score,
    pitchedNotes,
    partCount,
    measureCount,
    partNoteBalance,
    partDurationBalance,
    hasKeySignature,
    hasTimeSignature,
  };
}

export async function scoreMusicXmlArchive(mxlPath: string): Promise<MusicXmlQuality> {
  const zip = await JSZip.loadAsync(await fs.readFile(mxlPath));
  let best: MusicXmlQuality | null = null;
  for (const [name, entry] of Object.entries(zip.files)) {
    const lowerName = name.toLowerCase().replaceAll("\\", "/");
    if (
      entry.dir ||
      lowerName === "meta-inf/container.xml" ||
      !(lowerName.endsWith(".xml") || lowerName.endsWith(".musicxml"))
    ) {
      continue;
    }
    const document = parsePlayableMusicXml(await entry.async("string"), name);
    const quality = qualityForDocument(document);
    if (!best || quality.score > best.score) best = quality;
  }
  if (!best) throw new AudiverisError("MusicXML archive contains no score document");
  return best;
}

/** Remove sung lyrics with an XML parser, then validate the playable archive. */
export async function prepareMusicXmlArchive(
  mxlPath: string,
  removeLyrics: boolean
): Promise<void> {
  const zip = await JSZip.loadAsync(await fs.readFile(mxlPath));
  let changed = false;
  let scoreCount = 0;

  for (const [name, entry] of Object.entries(zip.files)) {
    const lowerName = name.toLowerCase().replaceAll("\\", "/");
    if (entry.dir || !(lowerName.endsWith(".xml") || lowerName.endsWith(".musicxml"))) {
      continue;
    }
    if (lowerName === "meta-inf/container.xml") continue;

    const xml = await entry.async("string");
    const document = parsePlayableMusicXml(xml, name);
    scoreCount++;
    if (removeLyrics) {
      const lyrics = Array.from(document.getElementsByTagName("lyric"));
      for (const lyric of lyrics) lyric.parentNode?.removeChild(lyric);
      if (lyrics.length > 0) {
        const cleanedXml = new XMLSerializer().serializeToString(document);
        parsePlayableMusicXml(cleanedXml, `${name} after lyric removal`);
        zip.file(name, cleanedXml);
        changed = true;
      }
    }
  }

  if (scoreCount === 0) {
    throw new AudiverisError("MusicXML archive contains no score document");
  }

  if (changed) {
    const cleaned = await zip.generateAsync({
      type: "nodebuffer",
      compression: "DEFLATE",
    });
    // Validate the exact bytes that will be served before replacing the file.
    const checkZip = await JSZip.loadAsync(cleaned);
    for (const [name, entry] of Object.entries(checkZip.files)) {
      const lowerName = name.toLowerCase().replaceAll("\\", "/");
      if (
        !entry.dir &&
        lowerName !== "meta-inf/container.xml" &&
        (lowerName.endsWith(".xml") || lowerName.endsWith(".musicxml"))
      ) {
        parsePlayableMusicXml(await entry.async("string"), name);
      }
    }
    await fs.writeFile(mxlPath, cleaned);
  }
}

async function selectValidExport(
  outputDir: string,
  removeLyrics: boolean
): Promise<string> {
  const candidates = await findFiles(outputDir, ".mxl");
  let lastError: unknown;
  const valid: Array<{ path: string; quality: MusicXmlQuality }> = [];
  for (const candidate of candidates) {
    try {
      await prepareMusicXmlArchive(candidate, removeLyrics);
      valid.push({ path: candidate, quality: await scoreMusicXmlArchive(candidate) });
    } catch (error) {
      lastError = error;
    }
  }
  if (valid.length > 0) {
    valid.sort((a, b) => compareMusicXmlCoverage(b.quality, a.quality));
    return valid[0].path;
  }
  if (lastError instanceof Error) throw lastError;
  throw new AudiverisError("Audiveris did not produce a valid .mxl output file");
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
    const isPhoto = /\.(?:avif|gif|jpe?g|png|tiff?|webp)$/i.test(inputPath);

    // Enable OCR when the language data is present: point Tesseract at it and
    // ask for Korean + English (these are Korean/English hymnals). Without the
    // data, run as before (no text OCR) rather than fail.
    const hasOcr = existsSync(TESSDATA_DIR);
    const args = ["-batch", "-export"];
    if (hasOcr) {
      args.push(
        "-constant",
        "org.audiveris.omr.text.Language$Constants.defaultSpecification=kor+eng"
      );
    }
    args.push(
      "-constant",
      "org.audiveris.omr.sheet.ProcessingSwitches$Constants.lyrics=false",
      "-constant",
      "org.audiveris.omr.sheet.ProcessingSwitches$Constants.chordNames=false",
      "-constant",
      "org.audiveris.omr.sheet.ProcessingSwitches$Constants.articulations=false"
    );

    args.push("-output", outputDir, "--", inputPath);

    const proc = spawn(AUDIVERIS_EXE, args, {
      windowsHide: true,
      env: hasOcr
        ? { ...process.env, TESSDATA_PREFIX: TESSDATA_DIR }
        : process.env,
    });

    let outputTail = "";
    const capture = (chunk: Buffer) => {
      const text = chunk.toString();
      outputTail = (outputTail + text).slice(-4000);
      onProgress?.(text);
    };
    proc.stdout?.on("data", capture);
    proc.stderr?.on("data", capture);

    proc.on("error", (err) => {
      reject(new AudiverisError(`Failed to start Audiveris: ${err.message}`));
    });

    proc.on("close", async (code) => {
      try {
        // Some Audiveris books contain one broken movement but still export a
        // valid sibling score before exiting nonzero. Validate candidates
        // instead of discarding usable work based only on the process code.
        resolve(await selectValidExport(outputDir, isPhoto));
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        reject(
          new AudiverisError(
            `Audiveris exited with code ${code ?? "unknown"}: ${detail}\n${outputTail}`.trim()
          )
        );
      }
    });
  });
}
