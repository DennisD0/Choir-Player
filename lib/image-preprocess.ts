import sharp from "sharp";

const IMAGE_EXT = /\.(jpe?g|png|gif|bmp|tiff?|webp|heic|heif)$/i;

/** Whether a file name looks like a raster photo/scan (not a PDF or MusicXML). */
export function isImageFile(name: string): boolean {
  return IMAGE_EXT.test(name);
}

/** Box-blur a 1-D profile to ignore single-column/row noise. */
function smooth(a: Float64Array, radius = 2): Float64Array {
  const out = new Float64Array(a.length);
  for (let i = 0; i < a.length; i++) {
    let sum = 0;
    let n = 0;
    for (let k = -radius; k <= radius; k++) {
      const j = i + k;
      if (j >= 0 && j < a.length) {
        sum += a[j];
        n++;
      }
    }
    out[i] = sum / n;
  }
  return out;
}

/** Widest contiguous run of indices whose value exceeds `thr`. */
function widestRun(a: Float64Array, thr: number): [number, number] {
  let best: [number, number] = [0, a.length - 1];
  let bestLen = -1;
  let start = -1;
  for (let i = 0; i < a.length; i++) {
    if (a[i] > thr) {
      if (start < 0) start = i;
    } else if (start >= 0) {
      if (i - start > bestLen) {
        bestLen = i - start;
        best = [start, i - 1];
      }
      start = -1;
    }
  }
  if (start >= 0 && a.length - start > bestLen) best = [start, a.length - 1];
  return best;
}

/**
 * For an open-book photo, find the single page to OMR. Both pages of an open
 * book are bright paper separated by a dark gutter (and dark table/background
 * around the edges); Audiveris treats the second page as extra "pages" and
 * fails to export. We take the widest contiguous run of bright (paper) columns
 * — the main page — then trim top/bottom the same way, isolating one page.
 * Returns a crop region for the (already EXIF/upright-oriented) image, or null
 * if there's nothing safe to trim.
 */
async function detectPageCrop(oriented: Buffer): Promise<sharp.Region | null> {
  try {
    const { data, info } = await sharp(oriented)
      .grayscale()
      .resize({ width: 160, fit: "inside" })
      .raw()
      .toBuffer({ resolveWithObject: true });
    const W = info.width;
    const H = info.height;
    const PAPER = 135; // luma above this is lit paper

    const col = new Float64Array(W);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) if (data[y * W + x] > PAPER) col[x]++;
    }
    for (let x = 0; x < W; x++) col[x] /= H;
    // Low threshold: only the near-black gutter/background breaks a page run,
    // not a broad lighting shadow across the page.
    const [x0, x1] = widestRun(smooth(col), 0.15);

    const row = new Float64Array(H);
    for (let y = 0; y < H; y++) {
      let c = 0;
      for (let x = x0; x <= x1; x++) if (data[y * W + x] > PAPER) c++;
      row[y] = c / (x1 - x0 + 1);
    }
    const [y0, y1] = widestRun(smooth(row), 0.15);

    const mx = (x1 - x0) * 0.03; // keep a little margin around the page
    const my = (y1 - y0) * 0.03;
    const lf = Math.max(0, (x0 - mx) / W);
    const rf = Math.min(1, (x1 + mx + 1) / W);
    const tf = Math.max(0, (y0 - my) / H);
    const bf = Math.min(1, (y1 + my + 1) / H);

    // Bail if the region looks wrong (too small) or there's nothing to trim.
    if (rf - lf < 0.3 || bf - tf < 0.3) return null;
    if (rf - lf > 0.97 && bf - tf > 0.97) return null;

    const meta = await sharp(oriented).metadata();
    const FW = meta.width ?? 0;
    const FH = meta.height ?? 0;
    if (!FW || !FH) return null;
    const left = Math.round(lf * FW);
    const top = Math.round(tf * FH);
    return {
      left,
      top,
      width: Math.min(FW - left, Math.round((rf - lf) * FW)),
      height: Math.min(FH - top, Math.round((bf - tf) * FH)),
    };
  } catch {
    return null;
  }
}

/**
 * Whether the page's staff lines run vertically (the photo is rotated ~90°).
 * Staff lines are the strongest long-line structure on a score: when they're
 * horizontal, whole rows are dark (high row-projection variance); when the page
 * is on its side, whole columns are dark instead. Compares the two.
 */
async function stavesAreVertical(input: Uint8Array): Promise<boolean> {
  try {
    const { data, info } = await sharp(input, { failOn: "none" })
      .rotate() // honor EXIF first
      .grayscale()
      .resize({ width: 800, height: 800, fit: "inside" })
      .raw()
      .toBuffer({ resolveWithObject: true });
    const W = info.width;
    const H = info.height;
    const rows = new Float64Array(H);
    const cols = new Float64Array(W);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const dark = 255 - data[y * W + x];
        rows[y] += dark;
        cols[x] += dark;
      }
    }
    const variance = (a: Float64Array): number => {
      let mean = 0;
      for (const v of a) mean += v;
      mean /= a.length;
      let sum = 0;
      for (const v of a) sum += (v - mean) ** 2;
      return sum / a.length;
    };
    // Normalize by the number of pixels summed so the two axes are comparable.
    const vRows = variance(rows) / (W * W);
    const vCols = variance(cols) / (H * H);
    return vCols > vRows * 1.3;
  } catch {
    return false;
  }
}

/** Render the EXIF-corrected image rotated by `deg`, grayscaled and downscaled. */
async function candidate(input: Uint8Array, deg: number): Promise<Buffer> {
  let pipe = sharp(input, { failOn: "none" }).rotate();
  if (deg) pipe = pipe.rotate(deg);
  return pipe
    .grayscale()
    .resize({ width: 1100, height: 1100, fit: "inside" })
    .png()
    .toBuffer();
}

/**
 * For a page whose staves are vertical, decide whether it's rotated 90° or
 * 270° by OCR-ing both candidates and keeping whichever reads as the most real
 * text (upright text recognizes far better than upside-down). Returns the
 * degrees to rotate the EXIF-corrected image so it stands upright.
 */
async function uprightRotation(input: Uint8Array): Promise<number> {
  if (!(await stavesAreVertical(input))) return 0; // already horizontal

  try {
    const { createWorker } = await import("tesseract.js");
    const worker = await createWorker("eng");
    try {
      let best = 90;
      let bestScore = -1;
      for (const deg of [90, 270]) {
        const { data } = await worker.recognize(await candidate(input, deg));
        const letters = (data.text.match(/[A-Za-z]/g) ?? []).length;
        const score = letters * (data.confidence ?? 0);
        if (score > bestScore) {
          bestScore = score;
          best = deg;
        }
      }
      return best;
    } finally {
      await worker.terminate();
    }
  } catch {
    return 90; // OCR unavailable: still turn it upright-ish so OMR has a chance
  }
}

/**
 * Clean up a photographed/scanned page before OMR so it survives real-world
 * conditions — bad/uneven lighting, shadows, low contrast, small or sideways
 * shots. We auto-orient (EXIF + a content-based 90° turn so staves run
 * horizontally), normalize size, go grayscale, then apply CLAHE (Contrast
 * Limited Adaptive Histogram Equalization) which equalizes contrast *locally*
 * in tiles — the key to rescuing a page that's bright on one side and shadowed
 * on the other — and finally sharpen. Audiveris does its own adaptive
 * binarization, so we deliberately stop short of a hard global threshold
 * (which destroys shadowed regions).
 *
 * Returns a PNG buffer, or null if preprocessing fails (caller keeps original).
 */
export async function preprocessImage(
  input: Uint8Array
): Promise<Buffer | null> {
  try {
    const turn = await uprightRotation(input);

    // Render the EXIF + upright-turned image once, then isolate a single page
    // (so an open-book photo's facing page doesn't break OMR).
    let oriented = sharp(input, { failOn: "none" }).rotate();
    if (turn) oriented = oriented.rotate(turn);
    const orientedBuf = await oriented.toBuffer();

    const crop = await detectPageCrop(orientedBuf);
    let base = sharp(orientedBuf);
    if (crop) base = base.extract(crop);

    // Cap size (and upscale small shots) so CLAHE tiles are a sane scale.
    const gray = await base
      .grayscale()
      .resize({ width: 2000, height: 2600, fit: "inside", withoutEnlargement: false })
      .png()
      .toBuffer();

    // CLAHE and sharpen must be separate libvips passes — chaining them on a
    // grayscale image trips a "must be UCHAR" error.
    const equalized = await sharp(gray)
      .clahe({ width: 180, height: 180, maxSlope: 3 })
      .png()
      .toBuffer();

    return await sharp(equalized).sharpen().png().toBuffer();
  } catch {
    return null;
  }
}
