import assert from "node:assert/strict";
import test from "node:test";
import {
  detectHymnBoxFromWords,
  detectHymnSelectionFromWords,
  type HymnOcrWord,
} from "./hymn-crop.ts";

function fillerWords(): HymnOcrWord[] {
  return Array.from({ length: 20 }, (_, index) => ({
    text: "word",
    confidence: 95,
    bbox: { x0: 700, y0: 100 + index * 30, x1: 760, y1: 120 + index * 30 },
  }));
}

test("accepts a punctuation-prefixed lower hymn number", () => {
  const words = [
    ...fillerWords(),
    { text: "432", confidence: 95, bbox: { x0: 30, y0: 264, x1: 150, y1: 353 } },
    { text: '"433', confidence: 43, bbox: { x0: 23, y0: 1804, x1: 145, y1: 1892 } },
  ];
  const box = detectHymnBoxFromWords(words, 1800, 2400);
  assert.ok(box);
  assert.ok(Math.abs(box.y - 0.105) < 0.001);
  assert.ok(box.h > 0.67 && box.h < 0.69);
  assert.equal(detectHymnSelectionFromWords(words, 1800, 2400)?.hymnNumber, "432");
});

test("does not auto-select below one unbounded top heading", () => {
  const words = [
    ...fillerWords(),
    { text: "432", confidence: 95, bbox: { x0: 30, y0: 264, x1: 150, y1: 353 } },
  ];
  assert.equal(detectHymnBoxFromWords(words, 1800, 2400), null);
});

test("uses a lone lower heading as the end of the main hymn", () => {
  const words = [
    ...fillerWords(),
    { text: "430", confidence: 94, bbox: { x0: 20, y0: 1973, x1: 150, y1: 2061 } },
  ];
  const box = detectHymnBoxFromWords(words, 1800, 2400);
  assert.ok(box);
  assert.equal(box.y, 0);
  assert.ok(box.h > 0.85 && box.h < 0.87);
  assert.equal(detectHymnSelectionFromWords(words, 1800, 2400)?.hymnNumber, "429");
});
