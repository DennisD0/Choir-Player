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
  /**
   * Global staff indices (into OSMD's MeasureList[measure][staff]) this part
   * is rendered on, so the UI can highlight the right staff. Soprano/alto
   * share the upper choral staff; tenor/bass share the lower one.
   */
  staves: number[];
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

type Instrument = MusicSheet["Instruments"][number];

/** A note plus its numeric pitch, used while splitting chords by height. */
type RawNote = NoteEvent & { halfTone: number };

const ROLE_LABELS: Record<PartRole, string> = {
  soprano: "Soprano",
  alto: "Alto",
  tenor: "Tenor",
  bass: "Bass",
  piano: "Piano",
  other: "Other",
};

/** Strip the sort-only halfTone field back to a plain NoteEvent. */
function toNoteEvent({ onsetTicks, durationTicks, pitch }: RawNote): NoteEvent {
  return { onsetTicks, durationTicks, pitch };
}

/** Every pitched note of an instrument, across all its voices. */
function collectNotes(instrument: Instrument): RawNote[] {
  const notes: RawNote[] = [];
  for (const voice of instrument.Voices) {
    for (const entry of voice.VoiceEntries) {
      for (const note of entry.Notes) {
        if (note.isRest()) continue;
        const pitch = note.Pitch;
        if (!pitch) continue;

        // Honor ties: a tie binds the same pitch across notes into one held
        // note. Emit it once (at the tie's start) with the summed duration and
        // skip the continuations. Slurs are a separate object and untouched.
        const tie = note.NoteTie;
        let durationWhole = note.Length.RealValue;
        if (tie) {
          if (tie.StartNote && note !== tie.StartNote) continue;
          const tied = tie.Notes ?? [note];
          durationWhole = tied.reduce((sum, n) => sum + n.Length.RealValue, 0);
        }

        const onsetWhole = note.getAbsoluteTimestamp().RealValue;
        notes.push({
          onsetTicks: Math.round(onsetWhole * TICKS_PER_WHOLE_NOTE),
          durationTicks: Math.max(
            1,
            Math.round(durationWhole * TICKS_PER_WHOLE_NOTE)
          ),
          pitch: pitch.ToStringShort(),
          halfTone: pitch.getHalfTone(),
        });
      }
    }
  }
  return notes;
}

/**
 * Split one choral staff into its top line (soprano/tenor) and second line
 * (alto/bass). Notes sharing an onset form a chord: the highest is the top
 * voice, the next-highest the second voice. A lone note at an onset is a
 * unison and is sung by both lines.
 */
function splitStaff(notes: RawNote[]): { top: NoteEvent[]; second: NoteEvent[] } {
  const byOnset = new Map<number, RawNote[]>();
  for (const note of notes) {
    const group = byOnset.get(note.onsetTicks);
    if (group) group.push(note);
    else byOnset.set(note.onsetTicks, [note]);
  }

  const top: NoteEvent[] = [];
  const second: NoteEvent[] = [];
  for (const group of byOnset.values()) {
    group.sort((a, b) => b.halfTone - a.halfTone); // highest pitch first
    top.push(toNoteEvent(group[0]));
    second.push(toNoteEvent(group[1] ?? group[0]));
  }
  top.sort((a, b) => a.onsetTicks - b.onsetTicks);
  second.sort((a, b) => a.onsetTicks - b.onsetTicks);
  return { top, second };
}

/** Drop notes that repeat the same pitch at the same onset. */
function dedupe(notes: NoteEvent[]): NoteEvent[] {
  const seen = new Set<string>();
  const out: NoteEvent[] = [];
  for (const note of notes) {
    const key = `${note.onsetTicks}:${note.pitch}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(note);
  }
  return out;
}

/**
 * Extracts S/A/T/B/Piano parts from the parsed OSMD sheet.
 *
 * Most choral scores are written "closed": two staves named generically
 * (e.g. "Voice"), the upper carrying soprano (top) + alto (below) and the
 * lower carrying tenor (top) + bass (below), stacked as chords. We detect
 * that layout and split each staff by pitch. Scores that explicitly name
 * their parts (Soprano/Alto/... ) are taken at face value instead.
 *
 * The piano part is used when present; when a score has no written piano,
 * the Piano part instead plays every voice at once, so the keyboard option
 * always sounds the full texture.
 */
export function extractParts(sheet: MusicSheet): ScorePart[] {
  // Global staff index per instrument, in document order — matches OSMD's
  // MeasureList[measure][staff] indexing used for highlighting.
  const stavesOf = new Map<Instrument, number[]>();
  let staffCursor = 0;
  sheet.Instruments.forEach((instrument) => {
    const count = Math.max(1, instrument.Staves?.length ?? 1);
    const indices: number[] = [];
    for (let i = 0; i < count; i++) indices.push(staffCursor++);
    stavesOf.set(instrument, indices);
  });

  const pianoInstruments: Instrument[] = [];
  const namedVocals = new Map<PartRole, Instrument>();
  const unnamedVocals: Instrument[] = [];

  sheet.Instruments.forEach((instrument) => {
    const role =
      detectRole(instrument.Name) ?? detectRole(instrument.PartAbbreviation);
    if (role === "piano") {
      pianoInstruments.push(instrument);
    } else if (
      role === "soprano" ||
      role === "alto" ||
      role === "tenor" ||
      role === "bass"
    ) {
      if (!namedVocals.has(role)) namedVocals.set(role, instrument);
    } else {
      unnamedVocals.push(instrument);
    }
  });

  const roleNotes = new Map<PartRole, NoteEvent[]>();
  const roleStaves = new Map<PartRole, Set<number>>();
  const addNotes = (role: PartRole, notes: NoteEvent[]): void => {
    if (notes.length === 0) return;
    const existing = roleNotes.get(role);
    if (existing) existing.push(...notes);
    else roleNotes.set(role, notes);
  };
  const addStaves = (role: PartRole, ...instruments: Instrument[]): void => {
    let set = roleStaves.get(role);
    if (!set) roleStaves.set(role, (set = new Set<number>()));
    for (const instrument of instruments) {
      for (const index of stavesOf.get(instrument) ?? []) set.add(index);
    }
  };

  // Parts the score labelled explicitly are taken as-is.
  for (const [role, instrument] of namedVocals) {
    addNotes(role, collectNotes(instrument).map(toNoteEvent));
    addStaves(role, instrument);
  }

  if (namedVocals.size === 0) {
    // Closed score: split the upper staff into S/A and the lower into T/B.
    // Both voices on a staff share that staff for highlighting.
    const [upper, lower] = unnamedVocals;
    if (upper) {
      const { top, second } = splitStaff(collectNotes(upper));
      addNotes("soprano", top);
      addNotes("alto", second);
      addStaves("soprano", upper);
      addStaves("alto", upper);
    }
    if (lower) {
      const { top, second } = splitStaff(collectNotes(lower));
      addNotes("tenor", top);
      addNotes("bass", second);
      addStaves("tenor", lower);
      addStaves("bass", lower);
    }
    for (let i = 2; i < unnamedVocals.length; i++) {
      addNotes("other", collectNotes(unnamedVocals[i]).map(toNoteEvent));
      addStaves("other", unnamedVocals[i]);
    }
  } else {
    for (const instrument of unnamedVocals) {
      addNotes("other", collectNotes(instrument).map(toNoteEvent));
      addStaves("other", instrument);
    }
  }

  if (pianoInstruments.length > 0) {
    for (const instrument of pianoInstruments) {
      addNotes("piano", collectNotes(instrument).map(toNoteEvent));
      addStaves("piano", instrument);
    }
  } else {
    // No written piano: play (and highlight) all of the voices together.
    const everything: NoteEvent[] = [];
    const pianoStaves = new Set<number>();
    for (const role of ["soprano", "alto", "tenor", "bass", "other"] as PartRole[]) {
      const notes = roleNotes.get(role);
      if (notes) everything.push(...notes.map((n) => ({ ...n })));
      for (const index of roleStaves.get(role) ?? []) pianoStaves.add(index);
    }
    addNotes("piano", dedupe(everything));
    if (roleNotes.has("piano")) roleStaves.set("piano", pianoStaves);
  }

  const order: PartRole[] = ["soprano", "alto", "tenor", "bass", "piano", "other"];
  const parts: ScorePart[] = [];
  for (const role of order) {
    const notes = roleNotes.get(role);
    if (!notes || notes.length === 0) continue;
    notes.sort((a, b) => a.onsetTicks - b.onsetTicks);
    const staves = [...(roleStaves.get(role) ?? [])].sort((a, b) => a - b);
    parts.push({ id: role, label: ROLE_LABELS[role], role, notes, staves });
  }
  return parts;
}
