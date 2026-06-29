"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_BPM,
  TICKS_PER_WHOLE_NOTE,
  type PartRole,
  type ScorePart,
} from "@/lib/musicxml-parts";
import { partsToMidi } from "@/lib/midi-export";
import CropModal from "./crop-modal";
import type { AudioEngine } from "@/lib/audio-engine";
import type { OpenSheetMusicDisplay } from "opensheetmusicdisplay";

// The player's own lifecycle, independent of per-song upload/OMR progress.
type Stage = "idle" | "loading" | "ready" | "error";
type VoiceFilter = "piano" | "soprano" | "alto" | "tenor" | "bass";

// Each song in the library uploads and runs OMR on its own, in the background,
// so the user can play a finished one while others are still processing.
type SongStatus = "uploading" | "processing" | "ready" | "error";

interface Song {
  /** Stable client-side id (not the OMR jobId). */
  id: string;
  /** Display name — the uploaded file's name (or the demo's name). */
  name: string;
  status: SongStatus;
  /** MusicXML URL once ready: a blob: (direct upload) or /api/omr/result/…. */
  url?: string;
  /** Progress text while processing. */
  message?: string;
  error?: string;
  /** Tempo (BPM) recovered from the scanned page by OCR, when found. */
  ocrTempo?: number;
}

/** How many files may be added in a single selection. */
const MAX_UPLOAD = 5;

// These four are both valid PartRoles and VoiceFilters.
const VOCAL_ROLES: (PartRole & VoiceFilter)[] = [
  "soprano",
  "alto",
  "tenor",
  "bass",
];

// Fixed octave shift applied to playback: choral parts on a piano sampler sit
// low, so everything is raised by this many octaves.
const DEFAULT_OCTAVE = 3;

/** Light-blue highlight drawn over the staff(s) currently being played. */
const HIGHLIGHT_FILL = "rgba(59, 130, 246, 0.16)";
const HIGHLIGHT_BORDER = "rgba(59, 130, 246, 0.55)";
/** Red tint for the notes inside the highlighted measure. */
const NOTE_RED = "#ef4444";

/** Pre-processed demo score so the app can be tried instantly, no OMR wait.
 *  The .xml carries the work title and tempo (added back after OMR). */
const DEMO_URL = "/presets/remember-me.xml";
const DEMO_NAME = "기억하라 (Remember Me) — demo";

const FILTER_LABELS: Record<VoiceFilter, string> = {
  piano: "Piano",
  soprano: "Soprano",
  alto: "Alto",
  tenor: "Tenor",
  bass: "Bass",
};

/** Voice-filter pills available for a set of parts, in display order. */
function filtersForParts(parts: ScorePart[]): VoiceFilter[] {
  const roles = new Set(parts.map((p) => p.role));
  const filters: VoiceFilter[] = [];
  if (roles.has("piano")) filters.push("piano");
  for (const role of VOCAL_ROLES) {
    if (roles.has(role)) filters.push(role);
  }
  return filters;
}

/** A pixel rectangle in the score container's coordinate space. */
interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A stable client-side id for a Song. */
function newId(): string {
  return typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random()}`;
}

/**
 * Turn an uploaded file name into a song title: drop the extension and tidy
 * whitespace. Scanned PDFs carry no embedded title, so the file name — which
 * users name after the hymn — is the most reliable source.
 */
function cleanTitle(fileName: string): string {
  return (
    fileName
      .replace(/\.(pdf|mxl|xml|musicxml|png|jpe?g|gif|webp|bmp|tiff?)$/i, "")
      // Drop the internal "NNN-" hymn-number prefix the crop step prepends for
      // preset routing — it's our artifact, not part of the user's file name.
      .replace(/^\d{3}-/, "")
      .replace(/[_]+/g, " ")
      .replace(/\s+/g, " ")
      .trim() || fileName
  );
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export default function Home() {
  const [stage, setStage] = useState<Stage>("idle");
  const [statusMsg, setStatusMsg] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);

  // The song library: every uploaded file plus the demo, each tracking its own
  // background upload/OMR progress. `activeSongId` is the one loaded in the player.
  const [songs, setSongs] = useState<Song[]>([]);
  const [activeSongId, setActiveSongId] = useState<string | null>(null);
  // Inline rename: which song's name is being edited, and the working text.
  const [editingSongId, setEditingSongId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  // "Get sheet by number": fetches the high-res PDF via our server proxy and
  // feeds it straight into OMR — no manual download step.
  const [hymnQuery, setHymnQuery] = useState("");
  const [hymnFetching, setHymnFetching] = useState(false);
  const [hymnFetchError, setHymnFetchError] = useState<string | null>(null);
  const [uploadNote, setUploadNote] = useState<string | null>(null);
  // Photos awaiting the crop step, processed one at a time.
  const [cropQueue, setCropQueue] = useState<File[]>([]);

  const [parts, setParts] = useState<ScorePart[]>([]);
  const [selectedRoles, setSelectedRoles] = useState<VoiceFilter[]>([]);
  const [isPlaying, setIsPlaying] = useState(false);
  const [bpm, setBpm] = useState(DEFAULT_BPM);
  // Subtle human-like timing/dynamic variation. A ref mirrors it so a freshly
  // built engine (one per loaded score) can re-apply the user's choice.
  const [humanize, setHumanize] = useState(false);
  const humanizeRef = useRef(false);
  const [positionSec, setPositionSec] = useState(0);
  const [durationSec, setDurationSec] = useState(0);
  const [resultUrl, setResultUrl] = useState<string | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLElement>(null);
  const playerRef = useRef<HTMLElement>(null);
  const osmdRef = useRef<OpenSheetMusicDisplay | null>(null);
  const engineRef = useRef<AudioEngine | null>(null);

  const rafRef = useRef<number | null>(null);
  // Per-measure, per-staff pixel rectangles for drawing staff highlights.
  const measureRectsRef = useRef<(Rect | null)[][]>([]);
  // Tick at which each measure begins, for mapping playback time → measure.
  const measureStartTicksRef = useRef<number[]>([]);
  const currentMeasureRef = useRef(-1);
  // Sorted note onsets (ticks), for mapping playback time → the playing note.
  const stepOnsetsRef = useRef<number[]>([]);
  const currentOnsetRef = useRef(-1);
  // Live mirrors of state read inside rAF / observer / async callbacks.
  const partsRef = useRef<ScorePart[]>([]);
  const selectedRef = useRef<VoiceFilter[]>([]);
  const songsRef = useRef<Song[]>([]);
  // SVG notes currently tinted red, so they can be reverted on the next move.
  const coloredNotesRef = useRef<SVGElement[]>([]);
  // Rebuilds highlight geometry whenever OSMD re-renders the score SVG.
  const resizeObsRef = useRef<MutationObserver | null>(null);

  const cancelLoop = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      cancelLoop();
      resizeObsRef.current?.disconnect();
      engineRef.current?.dispose();
    };
  }, [cancelLoop]);

  useEffect(() => {
    partsRef.current = parts;
  }, [parts]);
  useEffect(() => {
    selectedRef.current = selectedRoles;
  }, [selectedRoles]);
  useEffect(() => {
    songsRef.current = songs;
  }, [songs]);

  /** Recompute per-measure, per-staff pixel rectangles from OSMD's layout. */
  const buildMeasureRects = useCallback(() => {
    const osmd = osmdRef.current;
    const container = containerRef.current;
    if (!osmd || !container) return;
    const svg = container.querySelector("svg");
    if (!svg) return;

    const svgBox = svg.getBoundingClientRect();
    const contBox = container.getBoundingClientRect();
    const offsetX = svgBox.left - contBox.left;
    const offsetY = svgBox.top - contBox.top;

    // OSMD lays out in abstract units; the SVG is those units scaled to pixels.
    const page = osmd.GraphicSheet?.MusicPages?.[0];
    const pageWidth = page?.PositionAndShape?.Size?.width;
    const factor =
      pageWidth && pageWidth > 0 ? svgBox.width / pageWidth : 10 * (osmd.Zoom ?? 1);

    // A staff's five lines span a fixed 4 OSMD units; bounding-box borders are
    // content-driven (they collapse on rest measures and balloon around notes),
    // so use the StaffLine's top with that fixed height. padY clears the lines.
    const STAFF_UNITS = 4;
    const padY = 1.2;
    const list = osmd.GraphicSheet?.MeasureList ?? [];
    measureRectsRef.current = list.map((staves) =>
      staves.map((measure) => {
        const ps = measure?.PositionAndShape;
        if (!ps) return null;
        // Horizontal extent from the measure, vertical band from its staff.
        const sps = measure.ParentStaffLine?.PositionAndShape;
        const top = sps ? sps.AbsolutePosition.y : ps.AbsolutePosition.y;
        return {
          x: offsetX + (ps.AbsolutePosition.x + ps.BorderLeft) * factor,
          y: offsetY + (top - padY) * factor,
          w: (ps.BorderRight - ps.BorderLeft) * factor,
          h: (STAFF_UNITS + 2 * padY) * factor,
        };
      })
    );
  }, []);

  /**
   * Draw blue boxes over the selected parts' staves for the current measure,
   * and tint the notes inside those staves red. Reverts the previous notes.
   */
  const drawHighlights = useCallback(() => {
    const overlay = overlayRef.current;
    if (!overlay) return;

    const staffIndices = new Set<number>();
    for (const part of partsRef.current) {
      if (selectedRef.current.includes(part.role as VoiceFilter)) {
        for (const staff of part.staves) staffIndices.add(staff);
      }
    }

    for (const el of coloredNotesRef.current) el.style.fill = "";
    coloredNotesRef.current = [];

    const measureIndex = currentMeasureRef.current;
    const row = measureRectsRef.current[measureIndex];
    const fragment = document.createDocumentFragment();
    if (row) {
      for (const staff of staffIndices) {
        const rect = row[staff];
        if (!rect) continue;
        const box = document.createElement("div");
        box.style.cssText =
          `position:absolute;left:${rect.x}px;top:${rect.y}px;` +
          `width:${rect.w}px;height:${rect.h}px;background:${HIGHLIGHT_FILL};` +
          `border:1.5px solid ${HIGHLIGHT_BORDER};border-radius:6px;` +
          `box-sizing:border-box;pointer-events:none;`;
        fragment.appendChild(box);
      }
    }
    overlay.replaceChildren(fragment);

    // Redden only the note(s) actually sounding now: the staff entry on each
    // selected staff whose onset matches the current playback position.
    const onset = currentOnsetRef.current;
    const measures = osmdRef.current?.GraphicSheet?.MeasureList?.[measureIndex];
    if (measures && onset >= 0) {
      type GNote = { getSVGGElement?: () => SVGGElement | null };
      for (const staff of staffIndices) {
        const measure = measures[staff];
        for (const entry of measure?.staffEntries ?? []) {
          const entryTick = Math.round(
            entry.getAbsoluteTimestamp().RealValue * TICKS_PER_WHOLE_NOTE
          );
          if (entryTick !== onset) continue;
          for (const voiceEntry of entry.graphicalVoiceEntries ?? []) {
            for (const note of voiceEntry.notes ?? []) {
              const el = (note as unknown as GNote).getSVGGElement?.();
              if (!el) continue;
              el.style.fill = NOTE_RED;
              coloredNotesRef.current.push(el);
              el.querySelectorAll<SVGElement>("*").forEach((child) => {
                child.style.fill = NOTE_RED;
                coloredNotesRef.current.push(child);
              });
            }
          }
        }
      }
    }

  }, []);

  /** Keep the active system centered in the space between the sticky header
   * and the fixed player. The player stays reachable while playback follows
   * the score, so the user can pause without fighting the automatic scroll. */
  const centerPlaybackMeasure = useCallback((measureIndex: number) => {
    const container = containerRef.current;
    const row = measureRectsRef.current[measureIndex];
    if (!container || !row) return;

    const selectedStaves = new Set<number>();
    for (const part of partsRef.current) {
      if (selectedRef.current.includes(part.role as VoiceFilter)) {
        for (const staff of part.staves) selectedStaves.add(staff);
      }
    }

    const selectedRects = row.filter(
      (rect, staff) => rect && (selectedStaves.size === 0 || selectedStaves.has(staff))
    ) as Rect[];
    const rects = selectedRects.length ? selectedRects : row.filter(Boolean) as Rect[];
    if (rects.length === 0) return;

    const top = Math.min(...rects.map((rect) => rect.y));
    const bottom = Math.max(...rects.map((rect) => rect.y + rect.h));
    const containerBox = container.getBoundingClientRect();
    // Active measure band, in viewport coordinates.
    const measureTop = containerBox.top + top;
    const measureBottom = containerBox.top + bottom;
    const measureCenter = (measureTop + measureBottom) / 2;

    // The usable band sits between the sticky header and the fixed player so the
    // active system never hides behind either chrome.
    const viewportTop = (headerRef.current?.getBoundingClientRect().bottom ?? 0) + 12;
    const viewportBottom =
      (playerRef.current?.getBoundingClientRect().top ?? window.innerHeight) - 12;
    if (viewportBottom <= viewportTop) return;

    // Only scroll when the active measure has drifted out of a comfort band; the
    // score otherwise jiggles on every measure boundary now that the player
    // occupies the lower screen. Keep it inside the middle ~60% of the band.
    const inset = (viewportBottom - viewportTop) * 0.2;
    const comfortTop = viewportTop + inset;
    const comfortBottom = viewportBottom - inset;
    if (measureTop >= comfortTop && measureBottom <= comfortBottom) return;

    const targetCenter = (viewportTop + viewportBottom) / 2;
    window.scrollBy({ top: measureCenter - targetCenter, behavior: "smooth" });
  }, []);

  /**
   * Map a playback position (ticks) to its measure (for the box) and to the
   * currently-sounding note onset (for the red note), and redraw if either
   * changed.
   */
  const syncHighlight = useCallback(
    (posTicks: number) => {
      const starts = measureStartTicksRef.current;
      if (starts.length === 0) return;
      let measure = 0;
      for (let i = 0; i < starts.length; i++) {
        if (starts[i] <= posTicks) measure = i;
        else break;
      }

      const onsets = stepOnsetsRef.current;
      let onset = onsets.length ? onsets[0] : -1;
      for (let i = 0; i < onsets.length; i++) {
        if (onsets[i] <= posTicks) onset = onsets[i];
        else break;
      }

      if (measure === currentMeasureRef.current && onset === currentOnsetRef.current) {
        return;
      }
      const measureChanged = measure !== currentMeasureRef.current;
      currentMeasureRef.current = measure;
      currentOnsetRef.current = onset;
      drawHighlights();
      if (measureChanged) centerPlaybackMeasure(measure);
    },
    [drawHighlights, centerPlaybackMeasure]
  );

  const tick = useCallback(function animationTick() {
    const engine = engineRef.current;
    if (!engine) return;

    const posSec = engine.getPositionSeconds();
    const dur = engine.getDurationSeconds();
    setPositionSec(posSec);
    syncHighlight(engine.getPositionTicks());

    if (posSec >= dur && dur > 0) {
      engine.stop();
      setIsPlaying(false);
      setPositionSec(0);
      currentMeasureRef.current = 0;
      currentOnsetRef.current = stepOnsetsRef.current[0] ?? -1;
      drawHighlights();
      cancelLoop();
      return;
    }
    rafRef.current = requestAnimationFrame(animationTick);
  }, [syncHighlight, drawHighlights, cancelLoop]);

  const loadScore = useCallback(async (
    musicXmlUrl: string,
    fallbackTitle?: string,
    preferredTempo?: number
  ) => {
    setStage("loading");
    setStatusMsg("Rendering score...");
    setError(null);

    try {
      const [{ OpenSheetMusicDisplay }, { extractParts }, { AudioEngine }] =
        await Promise.all([
          import("opensheetmusicdisplay"),
          import("@/lib/musicxml-parts"),
          import("@/lib/audio-engine"),
        ]);

      if (!containerRef.current) throw new Error("Score container not ready");

      // Tear down the previously loaded score so switching hymns replaces the
      // view instead of stacking a second SVG below the first.
      resizeObsRef.current?.disconnect();
      try {
        osmdRef.current?.clear();
      } catch {
        /* ignore */
      }
      osmdRef.current = null;
      containerRef.current.replaceChildren();
      overlayRef.current?.replaceChildren();

      const osmd = new OpenSheetMusicDisplay(containerRef.current, {
        autoResize: true,
        backend: "svg",
        drawTitle: true,
      });
      osmdRef.current = osmd;

      const blob = await fetch(musicXmlUrl).then((r) => r.blob());
      await osmd.load(blob);

      // Title the rendered score with the file name (the user's chosen name),
      // overriding any embedded title so what's drawn matches their file.
      if (fallbackTitle && osmd.Sheet) {
        osmd.Sheet.TitleString = fallbackTitle;
      }

      // Pack ~4 measures per system (two ends + a couple in the middle): cap
      // the per-line count and zoom out so they actually fit, instead of OSMD's
      // width-driven default that puts a single wide measure on each line. Must
      // be set after load() — load resets zoom.
      osmd.EngravingRules.RenderXMeasuresPerLineAkaSystem = 4;
      osmd.zoom = 0.5;
      osmd.render();
      osmd.cursor?.hide();

      // Walk the score once to learn the tick where each measure begins (for
      // the measure box) and every distinct note onset (for the playing-note).
      const measureStartTicks: number[] = [];
      const onsetSet = new Set<number>();
      osmd.cursor.reset();
      let guard = 0;
      while (!osmd.cursor.Iterator.EndReached && guard < 100000) {
        const measure = osmd.cursor.Iterator.CurrentMeasureIndex;
        const tick = Math.round(
          osmd.cursor.Iterator.currentTimeStamp.RealValue * TICKS_PER_WHOLE_NOTE
        );
        if (measureStartTicks[measure] === undefined) {
          measureStartTicks[measure] = tick;
        }
        onsetSet.add(tick);
        osmd.cursor.next();
        guard += 1;
      }
      osmd.cursor.reset();
      osmd.cursor.hide();
      // Forward-fill empty measures so the tick→measure lookup stays monotonic.
      for (let i = 0, last = 0; i < measureStartTicks.length; i++) {
        if (measureStartTicks[i] === undefined) measureStartTicks[i] = last;
        else last = measureStartTicks[i];
      }
      measureStartTicksRef.current = measureStartTicks;
      stepOnsetsRef.current = [...onsetSet].sort((a, b) => a - b);
      currentMeasureRef.current = 0;
      currentOnsetRef.current = stepOnsetsRef.current[0] ?? -1;

      buildMeasureRects();

      // OSMD's autoResize re-lays-out the SVG (just after load, and on window
      // resize), which shifts every measure. Recompute geometry and redraw the
      // highlights whenever the score's structure changes.
      resizeObsRef.current?.disconnect();
      const observer = new MutationObserver(() => {
        buildMeasureRects();
        drawHighlights();
      });
      observer.observe(containerRef.current, { childList: true, subtree: true });
      resizeObsRef.current = observer;

      const scoreParts = extractParts(osmd.Sheet);
      if (scoreParts.length === 0) {
        throw new Error("No playable notes were found in the recognized score.");
      }

      // Tempo priority: the score's own embedded tempo (MusicXML), else a tempo
      // OCR'd from the scanned page (OMR strips it), else the default.
      const scoreTempo = Math.round(osmd.Sheet?.DefaultStartTempoInBpm ?? 0);
      const startBpm =
        scoreTempo >= 20 && scoreTempo <= 400
          ? scoreTempo
          : preferredTempo && preferredTempo >= 20 && preferredTempo <= 400
            ? preferredTempo
            : DEFAULT_BPM;

      // The player title stays as the file name (set in resetForLoad); we do not
      // override it with the embedded or OCR'd score title — the user wants the
      // actual uploaded file name shown.

      const engine = new AudioEngine();
      setStatusMsg("Loading piano samples...");
      await engine.build(scoreParts, (loaded, total) => {
        setStatusMsg(`Loading piano samples (${loaded}/${total})...`);
      });
      engineRef.current = engine;
      engine.setBpm(startBpm);
      engine.setTranspose(DEFAULT_OCTAVE * 12);
      engine.setHumanize(humanizeRef.current);

      // Start with every part selected and audible; the user narrows from there.
      const initialSelection = filtersForParts(scoreParts);
      scoreParts.forEach((p) =>
        engine.setMute(p.id, !initialSelection.includes(p.role as VoiceFilter))
      );

      // Seed the refs synchronously so the first highlight draw has data.
      partsRef.current = scoreParts;
      selectedRef.current = initialSelection;
      setParts(scoreParts);
      setSelectedRoles(initialSelection);
      setBpm(startBpm);
      setPositionSec(0);
      setDurationSec(engine.getDurationSeconds());
      setIsPlaying(false);
      setResultUrl(musicXmlUrl);
      setStage("ready");
      setStatusMsg("");

      drawHighlights();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStage("error");
    }
  }, [buildMeasureRects, drawHighlights]);

  /** Patch a single song in the library by id. */
  const updateSong = useCallback((id: string, patch: Partial<Song>) => {
    setSongs((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  }, []);

  /** Begin inline-editing a song's name (seeds the draft with the current name). */
  const startRename = useCallback((song: Song) => {
    setEditingSongId(song.id);
    setEditDraft(song.name);
  }, []);

  /** Commit (or cancel, when blank) an inline rename. Keeps the player header
   * in sync when the renamed song is the one currently loaded. */
  const commitRename = useCallback(
    (id: string) => {
      const name = editDraft.trim();
      setEditingSongId(null);
      if (!name) return;
      updateSong(id, { name });
      if (activeSongId === id) setFileName(name);
    },
    [editDraft, updateSong, activeSongId]
  );

  /** Poll a song's OMR job until done/error, updating just that song. */
  const pollStatus = useCallback(
    (songId: string, jobId: string) => {
      const poll = async () => {
        try {
          const res = await fetch(`/api/omr/status/${jobId}`);
          const data = await res.json();

          if (data.status === "error") {
            updateSong(songId, { status: "error", error: data.error || "OMR failed" });
            return;
          }
          if (data.status === "done") {
            updateSong(songId, {
              status: "ready",
              url: `/api/omr/result/${jobId}`,
              message: undefined,
            });
            return;
          }
          updateSong(songId, { message: data.message || "Recognizing notes..." });
          setTimeout(poll, 1500);
        } catch (err) {
          updateSong(songId, {
            status: "error",
            error: err instanceof Error ? err.message : String(err),
          });
        }
      };
      poll();
    },
    [updateSong]
  );

  /** Upload + run OMR for one song in the background (no player interaction). */
  const processSong = useCallback(
    async (songId: string, file: File) => {
      // Direct MusicXML load — skip OMR entirely, ready immediately.
      if (/\.(mxl|xml|musicxml)$/i.test(file.name)) {
        updateSong(songId, { status: "ready", url: URL.createObjectURL(file) });
        return;
      }

      // OMR drops the printed tempo, so OCR the header in parallel just for the
      // tempo. We deliberately do NOT rename the song from the OCR'd title — the
      // song keeps the user's file name. Best-effort; never blocks.
      import("@/lib/ocr-tempo")
        .then(({ extractScoreMeta }) => extractScoreMeta(file))
        .then((meta) => {
          if (meta.tempo) updateSong(songId, { ocrTempo: meta.tempo });
        })
        .catch(() => {});

      try {
        const form = new FormData();
        form.append("file", file);
        const res = await fetch("/api/omr/process", { method: "POST", body: form });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || `Upload failed (${res.status})`);
        }
        const { jobId } = await res.json();
        updateSong(songId, {
          status: "processing",
          message: "Recognizing notes (this can take a minute or two)...",
        });
        pollStatus(songId, jobId);
      } catch (err) {
        updateSong(songId, {
          status: "error",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [updateSong, pollStatus]
  );

  /** Reset transport/engine state before loading anything new. */
  const resetForLoad = useCallback(
    (name: string) => {
      cancelLoop();
      resizeObsRef.current?.disconnect();
      engineRef.current?.dispose();
      engineRef.current = null;
      overlayRef.current?.replaceChildren();
      coloredNotesRef.current = [];
      measureRectsRef.current = [];
      measureStartTicksRef.current = [];
      stepOnsetsRef.current = [];
      currentMeasureRef.current = -1;
      currentOnsetRef.current = -1;
      partsRef.current = [];
      selectedRef.current = [];
      setParts([]);
      setSelectedRoles([]);
      setIsPlaying(false);
      setPositionSec(0);
      setDurationSec(0);
      // Note: blob: URLs are owned by their Song entry (so a song can be
      // replayed after switching away) and are revoked in removeSong, not here.
      setResultUrl(null);
      setError(null);
      setFileName(name);
    },
    [cancelLoop]
  );

  /** Load a ready song into the player and make it the active one. */
  const playSong = useCallback(
    async (song: Song) => {
      if (song.status !== "ready" || !song.url) return;
      if (song.id === activeSongId && (stage === "ready" || stage === "loading")) {
        return;
      }
      setActiveSongId(song.id);
      resetForLoad(song.name);
      await loadScore(song.url, song.name, song.ocrTempo);
    },
    [activeSongId, stage, resetForLoad, loadScore]
  );

  /** Add the demo to the library (once) and start playing it. */
  const handleDemo = useCallback(async () => {
    const existing = songsRef.current.find((s) => s.url === DEMO_URL);
    const id = existing?.id ?? newId();
    if (!existing) {
      setSongs((prev) => [
        ...prev,
        { id, name: DEMO_NAME, status: "ready", url: DEMO_URL },
      ]);
    }
    setActiveSongId(id);
    resetForLoad(DEMO_NAME);
    await loadScore(DEMO_URL, DEMO_NAME);
  }, [resetForLoad, loadScore]);

  /** Add up to MAX_UPLOAD files to the library; each processes on its own. */
  /** Register files as library songs and kick off their background processing. */
  const addToLibrary = useCallback(
    (files: File[]) => {
      const newSongs: Song[] = files.map((file) => ({
        id: newId(),
        name: cleanTitle(file.name),
        status: "uploading" as const,
      }));
      setSongs((prev) => [...prev, ...newSongs]);
      newSongs.forEach((song, i) => processSong(song.id, files[i]));
    },
    [processSong]
  );

  const handleFiles = useCallback(
    (fileList: FileList) => {
      const all = Array.from(fileList);
      const files = all.slice(0, MAX_UPLOAD);
      setUploadNote(
        all.length > MAX_UPLOAD
          ? `Only the first ${MAX_UPLOAD} files were added (max ${MAX_UPLOAD} at a time).`
          : null
      );

      // Photos go through the crop step (one at a time) so the user can frame
      // the intended hymn; PDFs/MusicXML go straight to the library.
      const isPhoto = (f: File) =>
        f.type.startsWith("image/") ||
        /\.(jpe?g|png|gif|bmp|tiff?|webp|heic|heif)$/i.test(f.name);
      const photos = files.filter(isPhoto);
      const rest = files.filter((f) => !isPhoto(f));
      if (rest.length) addToLibrary(rest);
      if (photos.length) setCropQueue((q) => [...q, ...photos]);
    },
    [addToLibrary]
  );

  /** Fetch the high-res PDF for a 새찬송가 number via our server proxy and
   * drop it straight into the OMR pipeline — no manual download step. */
  const fetchHymnSheet = useCallback(async () => {
    const n = parseInt(hymnQuery.trim(), 10);
    if (!Number.isFinite(n) || n < 1 || n > 645) return;
    setHymnFetching(true);
    setHymnFetchError(null);
    try {
      const res = await fetch(`/api/hymn-pdf/${n}`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Failed to fetch sheet (${res.status})`);
      }
      const blob = await res.blob();
      const padded = String(n).padStart(3, "0");
      const file = new File([blob], `${padded}장.pdf`, { type: "application/pdf" });
      addToLibrary([file]);
      setHymnQuery("");
    } catch (err) {
      setHymnFetchError(err instanceof Error ? err.message : String(err));
    } finally {
      setHymnFetching(false);
    }
  }, [hymnQuery, addToLibrary]);

  /** Finish cropping the current photo: add the chosen region to the library. */
  const handleCropConfirm = useCallback(
    (cropped: File) => {
      addToLibrary([cropped]);
      setCropQueue((q) => q.slice(1));
    },
    [addToLibrary]
  );
  const handleCropCancel = useCallback(() => {
    setCropQueue((q) => q.slice(1));
  }, []);

  /** Remove a song from the library, freeing its blob URL. */
  const removeSong = useCallback((id: string) => {
    setSongs((prev) => {
      const song = prev.find((s) => s.id === id);
      if (song?.url?.startsWith("blob:")) URL.revokeObjectURL(song.url);
      return prev.filter((s) => s.id !== id);
    });
    setActiveSongId((cur) => {
      if (cur !== id) return cur;
      // Removing the song that's loaded in the player: tear the player down and
      // clear the rendered score + highlights so nothing stale lingers.
      cancelLoop();
      resizeObsRef.current?.disconnect();
      engineRef.current?.dispose();
      engineRef.current = null;
      osmdRef.current?.clear();
      osmdRef.current = null;
      // clear() empties the SVG but leaves a tall, blank element behind; drop it.
      containerRef.current?.replaceChildren();
      overlayRef.current?.replaceChildren();
      setStage("idle");
      setIsPlaying(false);
      setParts([]);
      setSelectedRoles([]);
      setFileName(null);
      return null;
    });
  }, [cancelLoop]);

  const handlePlay = useCallback(async () => {
    const engine = engineRef.current;
    if (!engine) return;
    centerPlaybackMeasure(Math.max(0, currentMeasureRef.current));
    await engine.play();
    setIsPlaying(true);
    cancelLoop();
    rafRef.current = requestAnimationFrame(tick);
  }, [tick, cancelLoop, centerPlaybackMeasure]);

  const handlePause = useCallback(() => {
    engineRef.current?.pause();
    setIsPlaying(false);
    cancelLoop();
  }, [cancelLoop]);

  const handleStop = useCallback(() => {
    engineRef.current?.stop();
    setIsPlaying(false);
    setPositionSec(0);
    currentMeasureRef.current = 0;
    currentOnsetRef.current = stepOnsetsRef.current[0] ?? -1;
    drawHighlights();
    cancelLoop();
  }, [drawHighlights, cancelLoop]);

  const handleSeek = useCallback(
    (sec: number) => {
      const engine = engineRef.current;
      if (!engine) return;
      engine.seek(sec);
      setPositionSec(sec);
      syncHighlight(engine.getPositionTicks());
    },
    [syncHighlight]
  );

  const handleBpm = useCallback((value: number) => {
    engineRef.current?.setBpm(value);
    setBpm(value);
    setDurationSec(engineRef.current?.getDurationSeconds() ?? 0);
  }, []);

  const handleHumanize = useCallback((value: boolean) => {
    humanizeRef.current = value;
    engineRef.current?.setHumanize(value);
    setHumanize(value);
  }, []);

  const baseFileName = useMemo(
    () => (fileName ? fileName.replace(/\.[^./\\]+$/, "") : "score"),
    [fileName]
  );

  /** Export the parsed parts as a Standard MIDI File, matching playback pitch. */
  const handleExportMidi = useCallback(() => {
    if (parts.length === 0) return;
    const bytes = partsToMidi(parts, bpm, DEFAULT_OCTAVE * 12);
    const blob = new Blob([bytes as unknown as BlobPart], { type: "audio/midi" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${baseFileName}.mid`;
    link.click();
    URL.revokeObjectURL(url);
  }, [parts, bpm, baseFileName]);

  /** Toggle a part in/out of the selection: only selected parts play (and get
   *  highlighted). Multiple may be active at once. */
  const toggleRole = useCallback(
    (role: VoiceFilter) => {
      setSelectedRoles((prev) => {
        const next = prev.includes(role)
          ? prev.filter((r) => r !== role)
          : [...prev, role];
        selectedRef.current = next;
        const engine = engineRef.current;
        if (engine) {
          partsRef.current.forEach((p) =>
            engine.setMute(p.id, !next.includes(p.role as VoiceFilter))
          );
        }
        drawHighlights();
        return next;
      });
    },
    [drawHighlights]
  );

  useEffect(() => {
    if (stage !== "ready") return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing =
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "SELECT" ||
          target.tagName === "TEXTAREA");
      if (e.code === "Space" && !typing) {
        e.preventDefault();
        if (isPlaying) handlePause();
        else handlePlay();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [stage, isPlaying, handlePlay, handlePause]);

  const availableFilters = useMemo(() => filtersForParts(parts), [parts]);

  const activeSong = useMemo(
    () => songs.find((s) => s.id === activeSongId) ?? null,
    [songs, activeSongId]
  );
  const playerTitle = fileName ?? activeSong?.name ?? "Score";

  // Only the player blocks on loading now; uploads/OMR run in the background,
  // so the upload control stays available the whole time.
  const playerLoading = stage === "loading";

  return (
    <div className="min-h-full flex flex-col">
      {/* Header — matches the church cafe site's top-left brand mark */}
      <header ref={headerRef} className="bg-white border-b border-stone-100 sticky top-0 z-20 shadow-sm">
        <div className="max-w-3xl mx-auto px-4 py-3 flex items-center gap-2.5">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/logo.png"
            alt="New York Church"
            className="h-9 w-9 shrink-0 object-contain"
          />
          <div className="min-w-0">
            <h1 className="whitespace-nowrap font-black leading-tight tracking-tight text-blue-900 text-[clamp(0.78rem,4vw,1rem)]">
              NEW YORK CHURCH CHOIR
            </h1>
            <p className="text-stone-400 text-xs mt-0.5 tracking-wide truncate">
              Upload sheet music → hear it sung, voice by voice
            </p>
          </div>
        </div>
      </header>

      <main
        className={`flex-1 w-full max-w-3xl mx-auto px-4 py-6 flex flex-col gap-5 ${
          stage === "ready" ? "pb-44 sm:pb-40" : ""
        }`}
      >
        {/* Upload */}
        <section className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2.5">
            <label className="inline-flex cursor-pointer items-center gap-2 rounded-full bg-blue-900 px-5 py-2.5 text-sm font-bold text-white shadow-sm transition-colors hover:bg-blue-800 active:bg-blue-950">
              {songs.length > 0 ? "Add more hymns" : "Upload sheet music"}
              <input
                type="file"
                accept="image/*,.pdf,.mxl,.xml,.musicxml"
                className="hidden"
                multiple
                onChange={(e) => {
                  if (e.target.files?.length) handleFiles(e.target.files);
                  e.target.value = "";
                }}
              />
            </label>
            <label className="inline-flex cursor-pointer items-center gap-2 rounded-full border border-blue-200 bg-white px-5 py-2.5 text-sm font-bold text-blue-900 shadow-sm transition-colors hover:bg-blue-50 active:bg-blue-100">
              {/* camera icon */}
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor" aria-hidden>
                <path d="M9 3 7.2 5H4a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-3.2L15 3H9zm3 5a5 5 0 1 1 0 10 5 5 0 0 1 0-10zm0 2a3 3 0 1 0 0 6 3 3 0 0 0 0-6z" />
              </svg>
              Take a photo
              <input
                type="file"
                accept="image/*"
                capture="environment"
                className="hidden"
                onChange={(e) => {
                  if (e.target.files?.length) handleFiles(e.target.files);
                  e.target.value = "";
                }}
              />
            </label>
            <button
              onClick={handleDemo}
              className="inline-flex items-center gap-2 rounded-full border border-blue-200 bg-white px-5 py-2.5 text-sm font-bold text-blue-900 transition-colors hover:bg-blue-50"
            >
              Try the demo
            </button>
          </div>
          <p className="text-xs text-stone-400">
            Pick up to {MAX_UPLOAD}{" "}hymns at once (image, PDF, or MusicXML). They
            upload in the background — play one as soon as it&apos;s ready while the
            rest keep processing. Or tap{" "}
            <span className="font-semibold text-blue-900">Try the demo</span> for an
            instant example.
          </p>
          {uploadNote && (
            <p className="text-xs font-medium text-amber-600">{uploadNote}</p>
          )}

          {/* Get the official high-res sheet by number — fetches the PDF via
              our server proxy and sends it straight into OMR (no manual step). */}
          <div className="flex flex-col gap-1.5 rounded-2xl border border-stone-100 bg-stone-50 px-3 py-3">
            <label
              htmlFor="hymn-number"
              className="text-xs font-bold uppercase tracking-wide text-stone-400"
            >
              Get official sheet by number
            </label>
            <div className="flex items-center gap-2">
              <input
                id="hymn-number"
                type="number"
                inputMode="numeric"
                min={1}
                max={645}
                value={hymnQuery}
                onChange={(e) => { setHymnQuery(e.target.value); setHymnFetchError(null); }}
                onKeyDown={(e) => { if (e.key === "Enter") void fetchHymnSheet(); }}
                placeholder="새찬송가 no. (1–645)"
                disabled={hymnFetching}
                className="w-40 rounded-full border border-stone-200 bg-white px-4 py-2 text-sm text-stone-700 outline-none focus:border-blue-400 disabled:opacity-50"
              />
              <button
                onClick={() => void fetchHymnSheet()}
                disabled={!hymnQuery.trim() || hymnFetching}
                className="inline-flex items-center gap-2 rounded-full bg-blue-900 px-4 py-2 text-sm font-bold text-white transition-colors hover:bg-blue-800 disabled:opacity-40"
              >
                {hymnFetching ? (
                  <>
                    <svg className="h-3.5 w-3.5 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden>
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
                    </svg>
                    Fetching…
                  </>
                ) : (
                  "Get sheet"
                )}
              </button>
            </div>
            {hymnFetchError && (
              <p className="text-xs font-medium text-red-500">{hymnFetchError}</p>
            )}
            <p className="text-xs text-stone-400">
              Type a 새찬송가 number (1–645) and tap Get sheet — the high-res PDF
              loads automatically and starts recognizing. Clean scans recognize
              more accurately than photos.
            </p>
          </div>
        </section>

        {/* Library — every uploaded hymn with its own status */}
        {songs.length > 0 && (
          <section className="flex flex-col gap-2">
            <span className="text-xs font-bold uppercase tracking-wide text-stone-400">
              Hymns
            </span>
            <ul className="flex flex-col gap-2">
              {songs.map((song) => {
                const isActive = song.id === activeSongId;
                const ready = song.status === "ready";
                return (
                  <li
                    key={song.id}
                    className={`flex items-center gap-3 rounded-2xl border px-4 py-3 shadow-sm transition-colors ${
                      isActive
                        ? "border-blue-300 bg-blue-50"
                        : "border-stone-100 bg-white"
                    }`}
                  >
                    {/* Status indicator */}
                    {song.status === "uploading" || song.status === "processing" ? (
                      <span className="inline-block h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-blue-200 border-t-blue-900" />
                    ) : song.status === "error" ? (
                      <span className="shrink-0 text-red-500">⚠</span>
                    ) : (
                      <span className="shrink-0 text-blue-900">♪</span>
                    )}

                    <div className="min-w-0 flex-1">
                      {editingSongId === song.id ? (
                        <input
                          autoFocus
                          value={editDraft}
                          onChange={(e) => setEditDraft(e.target.value)}
                          onBlur={() => commitRename(song.id)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") commitRename(song.id);
                            else if (e.key === "Escape") setEditingSongId(null);
                          }}
                          aria-label="Score name"
                          className="w-full rounded border border-blue-300 bg-white px-2 py-0.5 text-sm font-bold text-stone-700 outline-none focus:border-blue-500"
                        />
                      ) : (
                        <p
                          onDoubleClick={() => startRename(song)}
                          title="Double-click to rename"
                          className={`truncate text-sm font-bold ${
                            isActive ? "text-blue-900" : "text-stone-700"
                          }`}
                        >
                          {song.name}
                        </p>
                      )}
                      <p className="truncate text-xs text-stone-400">
                        {song.status === "uploading" && "Uploading…"}
                        {song.status === "processing" &&
                          (song.message || "Recognizing notes…")}
                        {song.status === "ready" &&
                          (isActive && stage === "ready"
                            ? "Now playing"
                            : isActive && stage === "loading"
                              ? "Loading…"
                              : "Ready to play")}
                        {song.status === "error" &&
                          (song.error || "Failed to process")}
                      </p>
                    </div>

                    {ready && (
                      <button
                        onClick={() => playSong(song)}
                        disabled={isActive && (stage === "ready" || stage === "loading")}
                        className="shrink-0 rounded-full bg-blue-900 px-4 py-1.5 text-xs font-bold text-white transition-colors hover:bg-blue-800 disabled:opacity-40"
                      >
                        {isActive && stage === "ready" ? "Playing" : "Play"}
                      </button>
                    )}
                    {editingSongId !== song.id && (
                      <button
                        onClick={() => startRename(song)}
                        aria-label={`Rename ${song.name}`}
                        className="shrink-0 rounded-full px-2 py-1 text-sm leading-none text-stone-300 transition-colors hover:bg-stone-100 hover:text-stone-500"
                      >
                        ✎
                      </button>
                    )}
                    <button
                      onClick={() => removeSong(song.id)}
                      aria-label={`Remove ${song.name}`}
                      className="shrink-0 rounded-full px-2 py-1 text-lg leading-none text-stone-300 transition-colors hover:bg-stone-100 hover:text-stone-500"
                    >
                      ×
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        {/* Player loading / error */}
        {playerLoading && (
          <div className="flex items-center gap-3 rounded-2xl border border-stone-100 bg-white px-4 py-3 text-sm text-stone-600 shadow-sm">
            <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-blue-200 border-t-blue-900" />
            {statusMsg}
          </div>
        )}
        {error && (
          <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-500">
            {error}
          </div>
        )}

        {/* Playback + voice controls */}
        {stage === "ready" && (
          <section className="rounded-2xl border border-stone-100 bg-white p-4 sm:p-5 shadow-sm flex flex-col gap-5">
            {/* Now-playing title */}
            <p className="truncate text-sm font-black text-blue-900">
              {playerTitle}
            </p>
            {/* Transport row */}
            <div className="flex flex-wrap items-center gap-3">
              {isPlaying ? (
                <button
                  onClick={handlePause}
                  className="rounded-full bg-blue-900 px-6 py-2.5 text-sm font-bold text-white shadow-sm transition-colors hover:bg-blue-800 active:bg-blue-950"
                >
                  Pause
                </button>
              ) : (
                <button
                  onClick={handlePlay}
                  className="rounded-full bg-blue-900 px-6 py-2.5 text-sm font-bold text-white shadow-sm transition-colors hover:bg-blue-800 active:bg-blue-950"
                >
                  ▶ Play
                </button>
              )}
              <button
                onClick={handleStop}
                className="rounded-full bg-stone-100 px-5 py-2.5 text-sm font-bold text-stone-700 transition-colors hover:bg-stone-200"
              >
                Stop
              </button>

              <span className="tabular-nums text-sm font-medium text-stone-400">
                {formatTime(positionSec)} / {formatTime(durationSec)}
              </span>
            </div>

            {/* Seek bar */}
            <input
              type="range"
              min={0}
              max={durationSec || 0}
              step={0.05}
              value={Math.min(positionSec, durationSec)}
              onChange={(e) => handleSeek(Number(e.target.value))}
              className="w-full accent-blue-900"
              aria-label="Seek"
            />

            {/* Tempo */}
            <div className="flex items-center gap-3">
              <span className="text-xs font-bold uppercase tracking-wide text-stone-400">
                Tempo
              </span>
              <input
                type="range"
                min={40}
                max={200}
                value={bpm}
                onChange={(e) => handleBpm(Number(e.target.value))}
                className="flex-1 accent-blue-900"
                aria-label="Tempo"
              />
              <span className="w-20 text-right text-sm font-bold tabular-nums text-blue-900">
                {bpm} BPM
              </span>
            </div>

            {/* Humanize — subtle timing/dynamic variation for a less robotic feel */}
            <label className="flex cursor-pointer items-center gap-3 select-none">
              <span className="text-xs font-bold uppercase tracking-wide text-stone-400">
                Humanize
              </span>
              <button
                type="button"
                role="switch"
                aria-checked={humanize}
                aria-label="Humanize"
                onClick={() => handleHumanize(!humanize)}
                className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
                  humanize ? "bg-blue-900" : "bg-stone-300"
                }`}
              >
                <span
                  className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${
                    humanize ? "translate-x-5" : "translate-x-0"
                  }`}
                />
              </button>
              <span className="text-xs text-stone-400">
                natural timing &amp; dynamics
              </span>
            </label>

            {/* Voice selector — multi-select; only chosen parts play */}
            <div className="flex flex-col gap-2">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-xs font-bold uppercase tracking-wide text-stone-400">
                  Voices
                </span>
                <span className="text-xs text-stone-400">
                  tap to toggle — pick any combination
                </span>
              </div>
              <div className="flex flex-wrap gap-2">
                {availableFilters.map((filter) => {
                  const on = selectedRoles.includes(filter);
                  return (
                    <button
                      key={filter}
                      onClick={() => toggleRole(filter)}
                      aria-pressed={on}
                      className={`rounded-full border px-4 py-2 text-sm font-bold transition-all duration-150 ${
                        on
                          ? "border-blue-900 bg-blue-900 text-white"
                          : "border-stone-200 bg-white text-stone-500 hover:border-blue-300 hover:text-blue-900"
                      }`}
                    >
                      {FILTER_LABELS[filter]}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-end gap-1 border-t border-stone-100 pt-3">
              <span className="mr-auto text-xs font-bold uppercase tracking-wide text-stone-400">
                Export
              </span>
              {resultUrl && (
                <a
                  href={resultUrl}
                  download={`${baseFileName}.mxl`}
                  className="rounded-full px-3 py-1.5 text-xs font-bold text-stone-400 transition-colors hover:bg-stone-100 hover:text-blue-900"
                >
                  MusicXML ↓
                </a>
              )}
              <button
                onClick={handleExportMidi}
                className="rounded-full px-3 py-1.5 text-xs font-bold text-stone-400 transition-colors hover:bg-stone-100 hover:text-blue-900"
              >
                MIDI ↓
              </button>
            </div>
          </section>
        )}

        {/* Score */}
        <section
          className={`rounded-2xl border border-stone-100 bg-white p-3 sm:p-4 shadow-sm ${
            stage === "ready" ? "" : "min-h-[200px]"
          }`}
        >
          {stage === "idle" && (
            <div className="flex flex-col items-center gap-2 py-16 text-center">
              <p className="text-sm font-medium text-stone-400">
                No score loaded yet.
              </p>
              <p className="text-xs text-stone-400">
                Upload a photo, PDF, or MusicXML file — or try the demo — to
                begin.
              </p>
            </div>
          )}
          <div className="relative">
            <div ref={containerRef} className="rounded-lg bg-white" />
            <div
              ref={overlayRef}
              className="pointer-events-none absolute inset-0"
            />
          </div>
        </section>
      </main>

      {stage === "ready" && (
        <aside
          ref={playerRef}
          className="fixed inset-x-0 bottom-0 z-40 px-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]"
          aria-label="Music player"
        >
          <div className="mx-auto max-w-3xl overflow-hidden rounded-2xl border border-blue-100 bg-white/95 shadow-[0_-10px_35px_rgba(15,23,42,0.18)] backdrop-blur-xl">
            <div className="flex items-center gap-3 px-4 pt-3">
              <div className="min-w-0 flex-1">
                <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-blue-400">
                  Now playing
                </p>
                <p className="truncate text-sm font-black text-blue-950">
                  {playerTitle}
                </p>
              </div>
              <span className="shrink-0 text-xs font-semibold tabular-nums text-stone-400">
                {formatTime(positionSec)} / {formatTime(durationSec)}
              </span>
            </div>

            <input
              type="range"
              min={0}
              max={durationSec || 0}
              step={0.05}
              value={Math.min(positionSec, durationSec)}
              onChange={(event) => handleSeek(Number(event.target.value))}
              className="mx-4 mt-2 block w-[calc(100%_-_2rem)] accent-blue-900"
              aria-label="Playback position"
            />

            <div className="flex items-center justify-center gap-3 px-4 pb-3 pt-2">
              <button
                type="button"
                onClick={() => handleSeek(Math.max(0, positionSec - 10))}
                aria-label="Back 10 seconds"
                className="flex h-10 w-10 items-center justify-center rounded-full text-blue-900 transition-colors hover:bg-blue-50 active:bg-blue-100"
              >
                <span className="text-xs font-black" aria-hidden>−10</span>
              </button>

              <button
                type="button"
                onClick={isPlaying ? handlePause : handlePlay}
                aria-label={isPlaying ? "Pause" : "Play"}
                className="flex h-12 w-12 items-center justify-center rounded-full bg-blue-900 text-white shadow-md transition-colors hover:bg-blue-800 active:bg-blue-950"
              >
                {isPlaying ? (
                  <svg viewBox="0 0 24 24" className="h-6 w-6" fill="currentColor" aria-hidden>
                    <path d="M7 5.5A1.5 1.5 0 0 1 8.5 4h1A1.5 1.5 0 0 1 11 5.5v13A1.5 1.5 0 0 1 9.5 20h-1A1.5 1.5 0 0 1 7 18.5v-13Zm6 0A1.5 1.5 0 0 1 14.5 4h1A1.5 1.5 0 0 1 17 5.5v13a1.5 1.5 0 0 1-1.5 1.5h-1a1.5 1.5 0 0 1-1.5-1.5v-13Z" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 24 24" className="ml-0.5 h-6 w-6" fill="currentColor" aria-hidden>
                    <path d="M7.5 5.2a1.3 1.3 0 0 1 2-.98l9.2 6.8a1.2 1.2 0 0 1 0 1.96l-9.2 6.8a1.3 1.3 0 0 1-2-.98V5.2Z" />
                  </svg>
                )}
              </button>

              <button
                type="button"
                onClick={() => handleSeek(Math.min(durationSec, positionSec + 10))}
                aria-label="Forward 10 seconds"
                className="flex h-10 w-10 items-center justify-center rounded-full text-blue-900 transition-colors hover:bg-blue-50 active:bg-blue-100"
              >
                <span className="text-xs font-black" aria-hidden>+10</span>
              </button>

              <button
                type="button"
                onClick={handleStop}
                aria-label="Stop"
                className="ml-2 flex h-10 w-10 items-center justify-center rounded-full text-stone-500 transition-colors hover:bg-stone-100 active:bg-stone-200"
              >
                <span className="h-3.5 w-3.5 rounded-[3px] bg-current" aria-hidden />
              </button>
            </div>
          </div>
        </aside>
      )}

      {cropQueue.length > 0 && (
        <CropModal
          key={cropQueue.length}
          file={cropQueue[0]}
          onConfirm={handleCropConfirm}
          onCancel={handleCropCancel}
        />
      )}
    </div>
  );
}
