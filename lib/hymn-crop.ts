export interface HymnCropBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface HymnOcrWord {
  text: string;
  confidence: number;
  bbox: { x0: number; y0: number; x1: number; y1: number };
}

export interface HymnCropSelection {
  box: HymnCropBox;
  hymnNumber: string | null;
}

function hymnNumber(word: HymnOcrWord): string | null {
  // Tesseract commonly prefixes a hymn number with a quote or similar mark
  // (for example `"433`). Geometry keeps this relaxed text match safe.
  return word.text.trim().match(/(?:^|\D)(\d{3})(?:\D|$)/)?.[1] ?? null;
}

/** Select the largest complete hymn segment inferred from OCR words. */
export function detectHymnSelectionFromWords(
  words: HymnOcrWord[],
  width: number,
  height: number
): HymnCropSelection | null {
  if (words.length < 10 || width <= 0 || height <= 0) return null;

  const heights = words
    .map((word) => word.bbox.y1 - word.bbox.y0)
    .filter((value) => value > 0)
    .sort((a, b) => a - b);
  const medianHeight = heights[Math.floor(heights.length / 2)] || 1;

  const rawBoundaries = words
    .filter(
      (word) =>
        hymnNumber(word) !== null &&
        word.bbox.y1 - word.bbox.y0 > medianHeight * 1.6 &&
        word.bbox.x0 < width * 0.35 &&
        word.confidence > 35
    )
    .map((word) => ({ y: word.bbox.y0 / height, number: hymnNumber(word)! }))
    .sort((a, b) => a.y - b.y);

  const boundaries = rawBoundaries.filter(
    (value, index) => index === 0 || value.y - rawBoundaries[index - 1].y > 0.03
  );
  if (boundaries.length === 0) return null;

  // A lone heading near the top gives no trustworthy lower boundary. Do not
  // claim an automatic selection that may include the next hymn.
  if (boundaries.length === 1 && boundaries[0].y < 0.45) return null;

  const cuts = [0, ...boundaries.map((boundary) => boundary.y), 1];
  let best: [number, number, number] = [0, 1, 0];
  let bestHeight = -1;
  for (let index = 0; index < cuts.length - 1; index++) {
    const segmentHeight = cuts[index + 1] - cuts[index];
    if (segmentHeight > bestHeight) {
      bestHeight = segmentHeight;
      best = [cuts[index], cuts[index + 1], index];
    }
  }

  const top = Math.max(0, best[0] - 0.005);
  // Include a small amount past the following heading. The final bass staff
  // often overlaps that heading vertically; stopping above it clipped the
  // last system and caused Audiveris to invent incomplete parts.
  const bottom = best[1] < 1 ? Math.min(0.99, best[1] + 0.035) : 0.99;
  if (bottom - top > 0.9 || bottom - top < 0.25) return null;
  const boundaryAtStart = best[2] > 0 ? boundaries[best[2] - 1] : null;
  const boundaryAtEnd = boundaries[best[2]] ?? null;
  const inferredNumber = boundaryAtStart?.number ??
    (boundaryAtEnd ? String(Number(boundaryAtEnd.number) - 1) : null);
  return {
    box: { x: 0.02, y: top, w: 0.96, h: bottom - top },
    hymnNumber: inferredNumber,
  };
}

export function detectHymnBoxFromWords(
  words: HymnOcrWord[],
  width: number,
  height: number
): HymnCropBox | null {
  return detectHymnSelectionFromWords(words, width, height)?.box ?? null;
}
