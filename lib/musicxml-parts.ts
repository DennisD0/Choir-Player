import type { MusicSheet } from "opensheetmusicdisplay";

/** Tone.js Transport default pulses-per-quarter-note. */
export const PPQ = 192;
/** A whole note is 4 quarter notes. OSMD Fraction RealValues are in whole-note units. */
export const TICKS_PER_WHOLE_NOTE = PPQ * 4;
/** Initial tempo the transport is set to before scheduling notes. */
export const DEFAULT_BPM = 100;

export type PartRole = "soprano" | "alto" | "tenor" | "bass" | "piano" | "other";

export const PART_ROLES: { value: PartRole; label: string }[] = [
  { value: "soprano", label: "Soprano" },
  { value: "alto", label: "Alto" },
  { value: "tenor", label: "Tenor" },
  { value: "bass", label: "Bass" },
  { value: "piano", label: "Piano" },
  { value: "other", label: "Other" },
];

export interface NoteEvent {
  /** Onset position, in Tone.js Transport ticks (bpm-independent). */
  onsetTicks: number;
  /** Duration, in Tone.js Transport ticks (bpm-independent). */
  durationTicks: number;
  /** Scientific pitch notation, e.g. "C4". */
  pitch: string;
}

export interface ScorePart {
  id: string;
  /** Human readable label derived from the instrument/voice, for the UI. */
  label: string;
  role: PartRole;
  notes: NoteEvent[];
}

const ROLE_PATTERNS: { role: PartRole; pattern: RegExp }[] = [
  { role: "soprano", pattern: /soprano|sopran|^s\.?$|^s\d?$/i },
  { role: "alto", pattern: /alto|^a\.?$|^a\d?$/i },
  { role: "tenor", pattern: /tenor|^t\.?$|^t\d?$/i },
  { role: "bass", pattern: /bass|^b\.?$|^b\d?$/i },
  { role: "piano", pattern: /piano|keyboard|klavier|accompan|^pf\.?$|^kbd\.?$/i },
];

function detectRole(text: string | undefined | null): PartRole | undefined {
  if (!text) return undefined;
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  for (const { role, pattern } of ROLE_PATTERNS) {
    if (pattern.test(trimmed)) return role;
  }
  return undefined;
}

/**
 * Walks the parsed OSMD music sheet and extracts one ScorePart per
 * (instrument, voice) pair, with note events expressed in Transport ticks.
 *
 * Part roles (S/A/T/B/Piano) are guessed from instrument names/abbreviations.
 * Any part whose role couldn't be detected is filled in with the SATB roles
 * not yet used, in document order - this matches the conventional layout of
 * closed-score hymnals (treble staff voice 1/2 = soprano/alto, bass staff
 * voice 1/2 = tenor/bass). Callers should let the user override the result.
 */
export function extractParts(sheet: MusicSheet): ScorePart[] {
  interface RawPart {
    id: string;
    label: string;
    role?: PartRole;
    notes: NoteEvent[];
  }

  const rawParts: RawPart[] = [];

  sheet.Instruments.forEach((instrument, instrumentIndex) => {
    const voices = instrument.Voices;
    const instrumentName = instrument.Name;
    const instrumentRole =
      detectRole(instrumentName) ?? detectRole(instrument.PartAbbreviation);

    voices.forEach((voice, voiceIndex) => {
      const notes: NoteEvent[] = [];

      for (const entry of voice.VoiceEntries) {
        for (const note of entry.Notes) {
          if (note.isRest()) continue;
          const pitch = note.Pitch;
          if (!pitch) continue;

          const onsetWhole = note.getAbsoluteTimestamp().RealValue;
          const durationWhole = note.Length.RealValue;

          notes.push({
            onsetTicks: Math.round(onsetWhole * TICKS_PER_WHOLE_NOTE),
            durationTicks: Math.max(
              1,
              Math.round(durationWhole * TICKS_PER_WHOLE_NOTE)
            ),
            pitch: pitch.ToStringShort(),
          });
        }
      }

      notes.sort((a, b) => a.onsetTicks - b.onsetTicks);

      const label =
        voices.length > 1
          ? `${instrumentName || `Part ${instrumentIndex + 1}`} (Voice ${voiceIndex + 1})`
          : instrumentName || `Part ${instrumentIndex + 1}`;

      rawParts.push({
        id: `${instrumentIndex}-${voiceIndex}`,
        label,
        role: instrumentRole,
        notes,
      });
    });
  });

  // Fill in undetected roles with the SATB roles not yet claimed, in
  // document order. Anything left over (e.g. more than 4 unlabeled parts)
  // falls back to "other".
  const usedRoles = new Set(rawParts.map((p) => p.role).filter(Boolean));
  const fallbackQueue: PartRole[] = (["soprano", "alto", "tenor", "bass"] as PartRole[]).filter(
    (role) => !usedRoles.has(role)
  );

  return rawParts.map((part) => ({
    id: part.id,
    label: part.label,
    role: part.role ?? fallbackQueue.shift() ?? "other",
    notes: part.notes,
  }));
}
