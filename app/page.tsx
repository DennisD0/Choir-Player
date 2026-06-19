"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  DEFAULT_BPM,
  PART_ROLES,
  TICKS_PER_WHOLE_NOTE,
  type PartRole,
  type ScorePart,
} from "@/lib/musicxml-parts";
import type { AudioEngine } from "@/lib/audio-engine";
import type { OpenSheetMusicDisplay } from "opensheetmusicdisplay";

type Stage = "idle" | "uploading" | "processing" | "loading" | "ready" | "error";

interface PartUI extends ScorePart {
  mute: boolean;
  solo: boolean;
  volume: number; // dB
}

const ROLE_COLORS: Record<PartRole, string> = {
  soprano: "bg-rose-500",
  alto: "bg-amber-500",
  tenor: "bg-emerald-500",
  bass: "bg-sky-500",
  piano: "bg-zinc-500",
  other: "bg-zinc-400",
};

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

  const [parts, setParts] = useState<PartUI[]>([]);
  const [isPlaying, setIsPlaying] = useState(false);
  const [bpm, setBpm] = useState(DEFAULT_BPM);
  const [positionSec, setPositionSec] = useState(0);
  const [durationSec, setDurationSec] = useState(0);

  const containerRef = useRef<HTMLDivElement>(null);
  const osmdRef = useRef<OpenSheetMusicDisplay | null>(null);
  const engineRef = useRef<AudioEngine | null>(null);

  // Cursor follow state.
  const stepOnsetsRef = useRef<number[]>([]);
  const stepIndexRef = useRef(0);
  const rafRef = useRef<number | null>(null);

  const cancelLoop = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  // Clean up on unmount.
  useEffect(() => {
    return () => {
      cancelLoop();
      engineRef.current?.dispose();
    };
  }, [cancelLoop]);

  /** Position the OSMD cursor on the last step whose onset <= current ticks. */
  const syncCursor = useCallback((posTicks: number) => {
    const osmd = osmdRef.current;
    const onsets = stepOnsetsRef.current;
    if (!osmd || onsets.length === 0) return;

    let target = 0;
    while (target + 1 < onsets.length && onsets[target + 1] <= posTicks) {
      target += 1;
    }
    if (posTicks < onsets[0]) target = 0;

    if (target < stepIndexRef.current) {
      osmd.cursor.reset();
      stepIndexRef.current = 0;
    }
    while (stepIndexRef.current < target) {
      osmd.cursor.next();
      stepIndexRef.current += 1;
    }
    osmd.cursor.update();
  }, []);

  const tick = useCallback(() => {
    const engine = engineRef.current;
    if (!engine) return;

    const posSec = engine.getPositionSeconds();
    const dur = engine.getDurationSeconds();
    setPositionSec(posSec);
    syncCursor(engine.getPositionTicks());

    if (posSec >= dur && dur > 0) {
      engine.stop();
      setIsPlaying(false);
      setPositionSec(0);
      stepIndexRef.current = 0;
      osmdRef.current?.cursor.reset();
      osmdRef.current?.cursor.update();
      cancelLoop();
      return;
    }
    rafRef.current = requestAnimationFrame(tick);
  }, [syncCursor, cancelLoop]);

  const loadScore = useCallback(async (musicXmlUrl: string) => {
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

      osmdRef.current?.cursor?.hide();
      const osmd = new OpenSheetMusicDisplay(containerRef.current, {
        autoResize: true,
        backend: "svg",
        drawTitle: true,
        followCursor: true,
      });
      osmdRef.current = osmd;

      const blob = await fetch(musicXmlUrl).then((r) => r.blob());
      await osmd.load(blob);
      osmd.render();

      // Pre-compute the onset (in ticks) of each cursor step for precise,
      // lead-free playback following.
      osmd.cursor.reset();
      const onsets: number[] = [];
      let guard = 0;
      while (!osmd.cursor.Iterator.EndReached && guard < 100000) {
        onsets.push(
          osmd.cursor.Iterator.currentTimeStamp.RealValue * TICKS_PER_WHOLE_NOTE
        );
        osmd.cursor.next();
        guard += 1;
      }
      osmd.cursor.reset();
      osmd.cursor.show();
      stepOnsetsRef.current = onsets;
      stepIndexRef.current = 0;

      // Extract parts and build the audio graph.
      const scoreParts = extractParts(osmd.Sheet);
      if (scoreParts.length === 0) {
        throw new Error("No playable notes were found in the recognized score.");
      }

      const engine = new AudioEngine();
      setStatusMsg("Loading piano samples...");
      await engine.build(scoreParts, (loaded, total) => {
        setStatusMsg(`Loading piano samples (${loaded}/${total})...`);
      });
      engineRef.current = engine;
      engine.setBpm(DEFAULT_BPM);

      setParts(
        scoreParts.map((p) => ({ ...p, mute: false, solo: false, volume: 0 }))
      );
      setBpm(DEFAULT_BPM);
      setPositionSec(0);
      setDurationSec(engine.getDurationSeconds());
      setIsPlaying(false);
      setStage("ready");
      setStatusMsg("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStage("error");
    }
  }, []);

  const pollStatus = useCallback(
    async (jobId: string) => {
      try {
        const res = await fetch(`/api/omr/status/${jobId}`);
        const data = await res.json();

        if (data.status === "error") {
          setError(data.error || "OMR failed");
          setStage("error");
          return;
        }
        if (data.status === "done") {
          await loadScore(`/api/omr/result/${jobId}`);
          return;
        }
        setStatusMsg(data.message || "Recognizing notes...");
        setTimeout(() => pollStatus(jobId), 1500);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setStage("error");
      }
    },
    [loadScore]
  );

  const handleFile = useCallback(
    async (file: File) => {
      cancelLoop();
      engineRef.current?.dispose();
      engineRef.current = null;
      setParts([]);
      setIsPlaying(false);
      setPositionSec(0);
      setDurationSec(0);
      setError(null);
      setFileName(file.name);
      setStage("uploading");
      setStatusMsg("Uploading...");

      try {
        const form = new FormData();
        form.append("file", file);
        const res = await fetch("/api/omr/process", {
          method: "POST",
          body: form,
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || `Upload failed (${res.status})`);
        }
        const { jobId } = await res.json();
        setStage("processing");
        setStatusMsg("Recognizing notes (this can take a minute or two)...");
        pollStatus(jobId);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setStage("error");
      }
    },
    [pollStatus, cancelLoop]
  );

  // ---- Playback controls ----
  const handlePlay = useCallback(async () => {
    const engine = engineRef.current;
    if (!engine) return;
    await engine.play();
    setIsPlaying(true);
    cancelLoop();
    rafRef.current = requestAnimationFrame(tick);
  }, [tick, cancelLoop]);

  const handlePause = useCallback(() => {
    engineRef.current?.pause();
    setIsPlaying(false);
    cancelLoop();
  }, [cancelLoop]);

  const handleStop = useCallback(() => {
    engineRef.current?.stop();
    setIsPlaying(false);
    setPositionSec(0);
    stepIndexRef.current = 0;
    osmdRef.current?.cursor.reset();
    osmdRef.current?.cursor.update();
    cancelLoop();
  }, [cancelLoop]);

  const handleSeek = useCallback(
    (sec: number) => {
      const engine = engineRef.current;
      if (!engine) return;
      engine.seek(sec);
      setPositionSec(sec);
      syncCursor(engine.getPositionTicks());
    },
    [syncCursor]
  );

  const handleBpm = useCallback((value: number) => {
    engineRef.current?.setBpm(value);
    setBpm(value);
    setDurationSec(engineRef.current?.getDurationSeconds() ?? 0);
  }, []);

  const toggleMute = useCallback((id: string) => {
    setParts((prev) =>
      prev.map((p) => {
        if (p.id !== id) return p;
        const mute = !p.mute;
        engineRef.current?.setMute(id, mute);
        return { ...p, mute };
      })
    );
  }, []);

  const toggleSolo = useCallback((id: string) => {
    setParts((prev) =>
      prev.map((p) => {
        if (p.id !== id) return p;
        const solo = !p.solo;
        engineRef.current?.setSolo(id, solo);
        return { ...p, solo };
      })
    );
  }, []);

  const setPartVolume = useCallback((id: string, volume: number) => {
    engineRef.current?.setVolume(id, volume);
    setParts((prev) => prev.map((p) => (p.id === id ? { ...p, volume } : p)));
  }, []);

  const setPartRole = useCallback((id: string, role: PartRole) => {
    setParts((prev) => prev.map((p) => (p.id === id ? { ...p, role } : p)));
  }, []);

  const busy =
    stage === "uploading" || stage === "processing" || stage === "loading";

  return (
    <div className="min-h-full flex flex-col bg-zinc-50 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
      <header className="border-b border-zinc-200 dark:border-zinc-800 px-6 py-4">
        <h1 className="text-xl font-semibold tracking-tight">
          Choire Reader Player
        </h1>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          Upload sheet music → hear it sung, voice by voice.
        </p>
      </header>

      <main className="flex-1 w-full max-w-5xl mx-auto px-6 py-8 flex flex-col gap-6">
        {/* Upload */}
        <section className="flex flex-wrap items-center gap-4">
          <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200">
            {fileName ? "Choose a different file" : "Upload sheet music"}
            <input
              type="file"
              accept="image/*,.pdf"
              className="hidden"
              disabled={busy}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handleFile(f);
                e.target.value = "";
              }}
            />
          </label>
          {fileName && (
            <span className="text-sm text-zinc-500 dark:text-zinc-400 truncate">
              {fileName}
            </span>
          )}
        </section>

        {/* Status / errors */}
        {busy && (
          <div className="flex items-center gap-3 rounded-lg border border-zinc-200 bg-white px-4 py-3 text-sm dark:border-zinc-800 dark:bg-zinc-900">
            <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-zinc-300 border-t-zinc-900 dark:border-zinc-700 dark:border-t-white" />
            {statusMsg}
          </div>
        )}
        {error && (
          <div className="rounded-lg border border-rose-300 bg-rose-50 px-4 py-3 text-sm text-rose-800 dark:border-rose-900 dark:bg-rose-950 dark:text-rose-200">
            {error}
          </div>
        )}

        {/* Transport + parts (only when ready) */}
        {stage === "ready" && (
          <>
            <section className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
              <div className="flex flex-wrap items-center gap-4">
                <div className="flex items-center gap-2">
                  {isPlaying ? (
                    <button
                      onClick={handlePause}
                      className="rounded-full bg-zinc-900 px-5 py-2 text-sm font-medium text-white hover:bg-zinc-700 dark:bg-white dark:text-zinc-900"
                    >
                      Pause
                    </button>
                  ) : (
                    <button
                      onClick={handlePlay}
                      className="rounded-full bg-emerald-600 px-5 py-2 text-sm font-medium text-white hover:bg-emerald-500"
                    >
                      Play
                    </button>
                  )}
                  <button
                    onClick={handleStop}
                    className="rounded-full border border-zinc-300 px-4 py-2 text-sm font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
                  >
                    Stop
                  </button>
                </div>

                <div className="flex items-center gap-2 tabular-nums text-sm text-zinc-500 dark:text-zinc-400">
                  <span>{formatTime(positionSec)}</span>
                  <span>/</span>
                  <span>{formatTime(durationSec)}</span>
                </div>

                <div className="flex items-center gap-2">
                  <span className="text-sm text-zinc-500 dark:text-zinc-400">
                    Tempo
                  </span>
                  <input
                    type="range"
                    min={40}
                    max={200}
                    value={bpm}
                    onChange={(e) => handleBpm(Number(e.target.value))}
                    className="w-32 accent-zinc-900 dark:accent-white"
                  />
                  <span className="w-16 text-sm tabular-nums">{bpm} BPM</span>
                </div>
              </div>

              {/* Seek bar */}
              <input
                type="range"
                min={0}
                max={durationSec || 0}
                step={0.05}
                value={Math.min(positionSec, durationSec)}
                onChange={(e) => handleSeek(Number(e.target.value))}
                className="mt-4 w-full accent-emerald-600"
              />
            </section>

            {/* Voice mixer */}
            <section className="grid gap-3 sm:grid-cols-2">
              {parts.map((p) => (
                <div
                  key={p.id}
                  className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900"
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <span
                        className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${ROLE_COLORS[p.role]}`}
                      />
                      <span className="truncate text-sm font-medium">
                        {p.label}
                      </span>
                      <span className="shrink-0 text-xs text-zinc-400">
                        {p.notes.length} notes
                      </span>
                    </div>
                    <select
                      value={p.role}
                      onChange={(e) =>
                        setPartRole(p.id, e.target.value as PartRole)
                      }
                      className="shrink-0 rounded-md border border-zinc-300 bg-transparent px-2 py-1 text-xs dark:border-zinc-700"
                    >
                      {PART_ROLES.map((r) => (
                        <option key={r.value} value={r.value}>
                          {r.label}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="mt-3 flex items-center gap-2">
                    <button
                      onClick={() => toggleMute(p.id)}
                      className={`rounded-md px-2.5 py-1 text-xs font-medium ${
                        p.mute
                          ? "bg-rose-600 text-white"
                          : "border border-zinc-300 dark:border-zinc-700"
                      }`}
                    >
                      Mute
                    </button>
                    <button
                      onClick={() => toggleSolo(p.id)}
                      className={`rounded-md px-2.5 py-1 text-xs font-medium ${
                        p.solo
                          ? "bg-amber-500 text-white"
                          : "border border-zinc-300 dark:border-zinc-700"
                      }`}
                    >
                      Solo
                    </button>
                    <input
                      type="range"
                      min={-30}
                      max={6}
                      step={1}
                      value={p.volume}
                      onChange={(e) =>
                        setPartVolume(p.id, Number(e.target.value))
                      }
                      className="ml-auto w-28 accent-zinc-900 dark:accent-white"
                      title="Volume"
                    />
                  </div>
                </div>
              ))}
            </section>
          </>
        )}

        {/* Score */}
        <section
          className={`rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900 ${
            stage === "ready" ? "" : "min-h-[200px]"
          }`}
        >
          {stage === "idle" && (
            <p className="py-16 text-center text-sm text-zinc-400">
              No score loaded yet. Upload a photo or PDF of choral sheet music to
              begin.
            </p>
          )}
          {/* OSMD renders its SVG into this container. */}
          <div ref={containerRef} className="overflow-x-auto bg-white" />
        </section>
      </main>
    </div>
  );
}
