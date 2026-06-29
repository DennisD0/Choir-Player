/**
 * Standalone script — spawned as a child process by the hymn-sheet API route.
 * Runs outside Next.js's bundler so mupdf's WASM loads cleanly.
 *
 * Args: <pdfPath> <pageIndex0Based> <outputPngPath>
 */
import * as mupdf from "mupdf";
import { readFileSync, writeFileSync } from "fs";

const [, , pdfPath, pageArg, outPath] = process.argv;
const pageIndex = parseInt(pageArg, 10);

const bytes = readFileSync(pdfPath);
const doc = mupdf.Document.openDocument(bytes, "application/pdf");

// 300 DPI (scale = 300/72 ≈ 4.17) → ~2550×3300 px per page (~8.4 MP, well under
// Audiveris's 20 MP limit). Higher DPI means thicker stems/noteheads relative to
// staff height, which dramatically reduces Audiveris misreads.
const scale = 300 / 72;
const page = doc.loadPage(pageIndex);
const matrix = mupdf.Matrix.scale(scale, scale);
const pixmap = page.toPixmap(matrix, mupdf.ColorSpace.DeviceRGB, false, true);
writeFileSync(outPath, pixmap.asPNG());
