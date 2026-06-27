/**
 * Best-effort tempo extraction from a scanned score (PDF or image) via OCR.
 *
 * A scanned music PDF keeps its printed tempo (e.g. "♩ = 76") only in the
 * image — there is no text or data layer to read — so we rasterize the first
 * page, OCR the top region where tempo markings live, and parse a BPM out of
 * the text. Everything is lazy-loaded and wrapped so a failure just yields
 * null and never disturbs the upload flow.
 */

const MIN_BPM = 30;
const MAX_BPM = 300;

/** Render the first page of a PDF (or an image file) to a canvas. */
async function rasterizeFirstPage(file: File): Promise<HTMLCanvasElement | null> {
  const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);

  if (isPdf) {
    const pdfjs = await import("pdfjs-dist");
    // Load the worker from the CDN (matching the installed version) so we don't
    // depend on bundler-specific worker resolution.
    pdfjs.GlobalWorkerOptions.workerSrc = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;

    const data = await file.arrayBuffer();
    const pdf = await pdfjs.getDocument({ data }).promise;
    const page = await pdf.getPage(1);

    // Target ~2200px wide: stylized tempo digits need the extra detail.
    const unit = page.getViewport({ scale: 1 });
    const scale = Math.min(4, Math.max(2, 2200 / unit.width));
    const viewport = page.getViewport({ scale });

    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    await page.render({ canvasContext: ctx, canvas, viewport }).promise;
    return canvas;
  }

  if (file.type.startsWith("image/")) {
    const bitmap = await createImageBitmap(file);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
    return canvas;
  }

  return null;
}

/** Copy the top `fraction` of a canvas — tempo markings sit near the top. */
function cropTop(canvas: HTMLCanvasElement, fraction: number): HTMLCanvasElement {
  const h = Math.max(1, Math.round(canvas.height * fraction));
  const out = document.createElement("canvas");
  out.width = canvas.width;
  out.height = h;
  out.getContext("2d")?.drawImage(canvas, 0, 0);
  return out;
}

/** Grayscale + threshold to crisp black-on-white, which sharpens digit OCR. */
function binarize(canvas: HTMLCanvasElement, threshold = 165): HTMLCanvasElement {
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    const v = lum < threshold ? 0 : 255;
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

/**
 * Pull a plausible BPM out of OCR'd text. Handles "♩ = 76" (the note glyph
 * usually OCRs as junk before the "="), and tempo words like "Freely 76".
 */
export function parseTempo(text: string): number | null {
  const norm = text.replace(/\s+/g, " ");
  const candidates: number[] = [];

  // "= 76" — the metronome equation, whatever precedes the "=". Most reliable.
  // (?!\d) so a 4+ digit run (page refs, measure counts) can't partly match.
  for (const m of norm.matchAll(/=\s*(\d{2,3})(?!\d)/g)) candidates.push(+m[1]);

  // A note glyph (♩, often OCR'd as J/d/o/q) then a dash/equals then a number.
  for (const m of norm.matchAll(/[♩♪Jdoq]\s*[-=]\s*(\d{2,3})(?!\d)/gi)) {
    candidates.push(+m[1]);
  }

  // On shadowed phone photos, Tesseract often turns "♩. =" into a compact
  // token such as "Ad" and drops the separator entirely (for example
  // "Ad 44"). Keep this narrow so hymn numbers and years are not candidates.
  for (const m of norm.matchAll(/\b(?:A?d|J|o|q)\b\s*[.=: -]*\s*(\d{2,3})(?!\d)/gi)) {
    candidates.push(+m[1]);
  }

  // A tempo word followed by a number.
  const word =
    /(freely|andante|andantino|allegretto|allegro|moderato|adagio|larghetto|largo|vivace|lento|grave|presto)\D{0,12}(\d{2,3})(?!\d)/i;
  const wm = norm.match(word);
  if (wm) candidates.push(+wm[2]);

  for (const bpm of candidates) {
    if (bpm >= MIN_BPM && bpm <= MAX_BPM) return bpm;
  }
  return null;
}

/** OCR a scanned score and return its tempo in BPM, or null if not found. */
export async function extractTempoFromFile(file: File): Promise<number | null> {
  try {
    const full = await rasterizeFirstPage(file);
    if (!full) return null;
    const region = binarize(cropTop(full, 0.3));

    const { createWorker } = await import("tesseract.js");
    const worker = await createWorker("eng");
    try {
      // Digit-focused sparse pass first — most reliable for stylized metronome
      // marks; fall back to a normal sparse pass.
      await worker.setParameters({
        tessedit_pageseg_mode: "11" as never,
        tessedit_char_whitelist: "0123456789=♩♪.Jdoq ",
      });
      let bpm = parseTempo((await worker.recognize(region)).data.text);
      if (bpm == null) {
        await worker.setParameters({
          tessedit_pageseg_mode: "11" as never,
          tessedit_char_whitelist: "",
        });
        bpm = parseTempo((await worker.recognize(region)).data.text);
      }
      return bpm;
    } finally {
      await worker.terminate();
    }
  } catch {
    return null;
  }
}
