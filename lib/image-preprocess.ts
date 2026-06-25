import sharp from "sharp";

const IMAGE_EXT = /\.(jpe?g|png|gif|bmp|tiff?|webp|heic|heif)$/i;

/** Whether a file name looks like a raster photo/scan (not a PDF or MusicXML). */
export function isImageFile(name: string): boolean {
  return IMAGE_EXT.test(name);
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

    let base = sharp(input, { failOn: "none" }).rotate(); // EXIF auto-orient
    if (turn) base = base.rotate(turn); // content-based upright turn

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
