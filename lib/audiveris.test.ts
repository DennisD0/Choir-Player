import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DOMParser } from "@xmldom/xmldom";
import JSZip from "jszip";
import {
  compareMusicXmlCoverage,
  isReliableNoteTranscription,
  prepareMusicXmlArchive,
  scoreMusicXmlArchive,
} from "./audiveris.ts";

test("prefers the main photographed movement over a metadata-rich fragment", () => {
  const mainMovement = {
    score: 380.63,
    pitchedNotes: 142,
    partCount: 2,
    measureCount: 7,
    partNoteBalance: 0.45,
    partDurationBalance: 0.37,
    hasKeySignature: false,
    hasTimeSignature: false,
  };
  const timeSignatureFragment = {
    score: 438,
    pitchedNotes: 34,
    partCount: 1,
    measureCount: 7,
    partNoteBalance: 1,
    partDurationBalance: 1,
    hasKeySignature: false,
    hasTimeSignature: true,
  };

  assert.ok(compareMusicXmlCoverage(mainMovement, timeSignatureFragment) > 0);
  assert.equal(isReliableNoteTranscription(mainMovement), true);
  assert.equal(isReliableNoteTranscription(timeSignatureFragment), false);
});

test("removes lyric elements without consuming lyric-font or score structure", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "choire-mxl-"));
  const archivePath = path.join(directory, "score.mxl");
  try {
    const score = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <defaults><lyric-font font-family="serif" font-size="10"/></defaults>
  <part-list><score-part id="P1"><part-name>Voice</part-name></score-part></part-list>
  <part id="P1"><measure number="1"><attributes><divisions>1</divisions></attributes>
    <note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration>
      <lyric><syllabic>single</syllabic><text>Sing</text></lyric>
    </note>
  </measure></part>
</score-partwise>`;
    const zip = new JSZip();
    zip.file("META-INF/container.xml", "<container/>");
    zip.file("score.xml", score);
    await writeFile(archivePath, await zip.generateAsync({ type: "nodebuffer" }));

    await prepareMusicXmlArchive(archivePath, true);

    const cleanedZip = await JSZip.loadAsync(await readFile(archivePath));
    const cleaned = await cleanedZip.file("score.xml")!.async("string");
    assert.match(cleaned, /<lyric-font\b/);
    assert.doesNotMatch(cleaned, /<lyric(?:\s|>)/);
    assert.match(cleaned, /<note>/);
    assert.match(cleaned, /<duration>1<\/duration>/);
    assert.equal(
      new DOMParser().parseFromString(cleaned, "application/xml").documentElement.localName,
      "score-partwise"
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects structurally invalid score XML", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "choire-mxl-"));
  const archivePath = path.join(directory, "score.mxl");
  try {
    const zip = new JSZip();
    zip.file("score.xml", "<score-partwise><defaults></note></score-partwise>");
    await writeFile(archivePath, await zip.generateAsync({ type: "nodebuffer" }));
    await assert.rejects(() => prepareMusicXmlArchive(archivePath, true), /Invalid MusicXML/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("scores balanced note-complete exports above fragments", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "choire-quality-"));
  const archive = async (name: string, score: string): Promise<string> => {
    const archivePath = path.join(directory, name);
    const zip = new JSZip();
    zip.file("score.xml", score);
    await writeFile(archivePath, await zip.generateAsync({ type: "nodebuffer" }));
    return archivePath;
  };
  const note = (step: string) =>
    `<note><pitch><step>${step}</step><octave>4</octave></pitch><duration>1</duration></note>`;
  try {
    const complete = await archive(
      "complete.mxl",
      `<score-partwise><part-list/><part id="P1"><measure number="1"><attributes><key><fifths>-4</fifths></key><time><beats>3</beats><beat-type>4</beat-type></time></attributes>${note("C")}${note("D")}</measure><measure number="2">${note("E")}</measure></part><part id="P2"><measure number="1">${note("C")}${note("D")}</measure><measure number="2">${note("E")}</measure></part></score-partwise>`
    );
    const fragment = await archive(
      "fragment.mxl",
      `<score-partwise><part-list/><part id="P1"><measure number="1">${note("C")}</measure></part><part id="P2"><measure number="1"></measure></part></score-partwise>`
    );

    const completeQuality = await scoreMusicXmlArchive(complete);
    const fragmentQuality = await scoreMusicXmlArchive(fragment);
    assert.ok(completeQuality.score > fragmentQuality.score);
    assert.equal(completeQuality.hasKeySignature, true);
    assert.equal(completeQuality.hasTimeSignature, true);
    assert.equal(completeQuality.partCount, 2);
    assert.equal(isReliableNoteTranscription(fragmentQuality), false);
    assert.equal(
      isReliableNoteTranscription({
        score: 600,
        pitchedNotes: 120,
        partCount: 2,
        measureCount: 20,
        partNoteBalance: 0.9,
        partDurationBalance: 0.9,
        hasKeySignature: true,
        hasTimeSignature: true,
      }),
      true
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
