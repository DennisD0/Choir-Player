import { PPQ, type ScorePart } from "./musicxml-parts";

/** Scientific pitch (e.g. "C4", "Db4", "F#4") → MIDI note number, or null. */
function pitchToMidi(pitch: string): number | null {
  const match = pitch.match(/^([A-G])(b{1,2}|#{1,2}|x)?(-?\d+)$/);
  if (!match) return null;
  const base: Record<string, number> = {
    C: 0,
    D: 2,
    E: 4,
    F: 5,
    G: 7,
    A: 9,
    B: 11,
  };
  let accidental = 0;
  switch (match[2]) {
    case "#":
      accidental = 1;
      break;
    case "##":
    case "x":
      accidental = 2;
      break;
    case "b":
      accidental = -1;
      break;
    case "bb":
      accidental = -2;
      break;
  }
  const octave = parseInt(match[3], 10);
  return base[match[1]] + accidental + (octave + 1) * 12;
}

/** MIDI variable-length quantity. */
function varLen(value: number): number[] {
  const bytes = [value & 0x7f];
  let rest = value >> 7;
  while (rest > 0) {
    bytes.unshift((rest & 0x7f) | 0x80);
    rest >>= 7;
  }
  return bytes;
}

const str = (s: string): number[] => [...s].map((c) => c.charCodeAt(0) & 0xff);
const u16 = (n: number): number[] => [(n >> 8) & 0xff, n & 0xff];
const u32 = (n: number): number[] => [
  (n >> 24) & 0xff,
  (n >> 16) & 0xff,
  (n >> 8) & 0xff,
  n & 0xff,
];

function append(dst: number[], src: number[]): void {
  for (let i = 0; i < src.length; i++) dst.push(src[i]);
}

/**
 * Encode the score parts as a Standard MIDI File (format 1): one tempo track
 * plus one track per part. `transpose` semitones is applied to every note so
 * the export matches what's played back.
 */
export function partsToMidi(
  parts: ScorePart[],
  bpm: number,
  transpose = 0
): Uint8Array {
  const tracks: number[][] = [];

  // Tempo track.
  const microsPerQuarter = Math.round(60000000 / Math.max(1, bpm));
  tracks.push([
    ...varLen(0),
    0xff,
    0x51,
    0x03,
    (microsPerQuarter >> 16) & 0xff,
    (microsPerQuarter >> 8) & 0xff,
    microsPerQuarter & 0xff,
    ...varLen(0),
    0xff,
    0x2f,
    0x00,
  ]);

  parts.forEach((part, index) => {
    const channel = Math.min(index, 15);
    const events: { tick: number; order: number; data: number[] }[] = [];
    for (const note of part.notes) {
      const midi = pitchToMidi(note.pitch);
      if (midi === null) continue;
      const value = Math.max(0, Math.min(127, midi + transpose));
      events.push({ tick: note.onsetTicks, order: 1, data: [0x90 | channel, value, 80] });
      events.push({
        tick: note.onsetTicks + note.durationTicks,
        order: 0, // releases before re-attacks at the same tick
        data: [0x80 | channel, value, 0],
      });
    }
    events.sort((a, b) => a.tick - b.tick || a.order - b.order);

    const bytes: number[] = [];
    const name = str(part.label);
    append(bytes, [...varLen(0), 0xff, 0x03, ...varLen(name.length)]);
    append(bytes, name);
    let last = 0;
    for (const event of events) {
      append(bytes, varLen(event.tick - last));
      append(bytes, event.data);
      last = event.tick;
    }
    append(bytes, [...varLen(0), 0xff, 0x2f, 0x00]);
    tracks.push(bytes);
  });

  const out: number[] = [];
  append(out, [...str("MThd"), ...u32(6), ...u16(1), ...u16(tracks.length), ...u16(PPQ)]);
  for (const track of tracks) {
    append(out, [...str("MTrk"), ...u32(track.length)]);
    append(out, track);
  }
  return new Uint8Array(out);
}
