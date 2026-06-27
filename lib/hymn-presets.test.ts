import assert from "node:assert/strict";
import test from "node:test";
import JSZip from "jszip";
import { getHymnPreset, hymnNumberFromFilename } from "./hymn-presets.ts";

test("extracts a cropper-prefixed hymn number", () => {
  assert.equal(hymnNumberFromFilename("429-Photo 1.jpg"), "429");
  assert.equal(hymnNumberFromFilename("Photo 1.jpg"), null);
});

test("serves a playable canonical hymn 429 archive", async () => {
  const preset = getHymnPreset("429");
  assert.ok(preset);
  const zip = await JSZip.loadAsync(preset);
  const score = zip.file("score-cleaned.xml");
  assert.ok(score);
  const xml = await score.async("string");
  assert.match(xml, /<score-partwise/);
  assert.match(xml, /<fifths>-4<\/fifths>/);
  assert.match(xml, /<beats>3<\/beats>/);
  assert.match(xml, /<beat-type>4<\/beat-type>/);
});

test("serves the canonical 16-measure hymn 432 in B-flat and 6/8", async () => {
  const preset = getHymnPreset("432");
  assert.ok(preset);
  const zip = await JSZip.loadAsync(preset);
  const score = Object.values(zip.files).find(
    (entry) => !entry.dir && /\.(?:xml|musicxml)$/i.test(entry.name) && !/META-INF/i.test(entry.name)
  );
  assert.ok(score);
  const xml = await score.async("string");
  assert.match(xml, /<fifths>-2<\/fifths>/);
  assert.match(xml, /<beats>6<\/beats>/);
  assert.match(xml, /<beat-type>8<\/beat-type>/);
  assert.equal((xml.match(/<measure(?:\s|>)/g) ?? []).length, 32);
});
