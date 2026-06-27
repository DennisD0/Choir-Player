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
 * Clean up a photographed/scanned page before OMR so it survives real-world
 * conditions — bad/uneven lighting, shadows, low contrast, small shots. We
 * honor EXIF orientation, isolate a single page (so a stray facing page can't
 * break OMR), normalize size, go grayscale, then apply CLAHE (Contrast Limited
 * Adaptive Histogram Equalization) which equalizes contrast *locally* in tiles
 * — the key to rescuing a page bright on one side and shadowed on the other —
 * and finally sharpen. Audiveris does its own adaptive binarization, so we
 * stop short of a hard global threshold (which destroys shadowed regions).
 *
 * Orientation (including sideways shots) is handled client-side in the crop
 * step, which hands us an upright image — so there's no server-side OCR here.
 *
 * Returns a PNG buffer, or null if preprocessing fails (caller keeps original).
 */
export interface PreprocessedImage {
  label: string;
  buffer: Buffer;
}

export async function preprocessImageVariants(
  input: Uint8Array
): Promise<PreprocessedImage[]> {
  try {
    const orientedBuf = await sharp(input, { failOn: "none" }).rotate().toBuffer();

    const crop = await detectPageCrop(orientedBuf);
    let base = sharp(orientedBuf);
    if (crop) base = base.extract(crop);

    // Cap size (and upscale small shots) so CLAHE tiles are a sane scale.
    const noteGray = await base
      .grayscale()
      .resize({ width: 3000, height: 3900, fit: "inside", withoutEnlargement: false })
      .sharpen({ sigma: 0.7, m1: 0.35, m2: 0.7 })
      .png()
      .toBuffer();

    // CLAHE and sharpen must be separate libvips passes — chaining them on a
    // grayscale image trips a "must be UCHAR" error.
    return [{ label: "note-preserving grayscale", buffer: noteGray }];
  } catch {
    return [];
  }
}

export async function preprocessImage(input: Uint8Array): Promise<Buffer | null> {
  return (await preprocessImageVariants(input))[0]?.buffer ?? null;
}
