export type HymnalEdition = "찬송가" | "은혜찬송";

export const HYMNAL_LABELS: Record<HymnalEdition, string> = {
  "찬송가": "찬송가 (1–558)",
  "은혜찬송": "은혜찬송 (1–308)",
};

export const HYMNAL_MAX: Record<HymnalEdition, number> = {
  "찬송가": 558,
  "은혜찬송": 308,
};

/**
 * PDF page number for a given hymn number and collection.
 * Page 1 of the PDF is a blank cover; 찬송가 hymn 1 is page 2.
 * 은혜찬송 starts immediately at page 560 (hymn 1 = page 560).
 */
export function toPdfPage(n: number, edition: HymnalEdition): number {
  if (edition === "찬송가") return n + 1;
  return n + 559;
}
