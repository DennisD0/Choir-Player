"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
} // all fractions of the displayed image, 0..1

type Mode = "move" | "nw" | "ne" | "sw" | "se";

const INIT: Box = { x: 0.08, y: 0.08, w: 0.84, h: 0.84 };

interface OcrWord {
  text: string;
  confidence: number;
  bbox: { x0: number; y0: number; x1: number; y1: number };
}

/**
 * When a page holds two hymns (common in hymnals), guess the one the user
 * means and return a box around it. Hymns are headed by a large bold number in
 * the left margin; we OCR for those, treat their vertical positions as hymn
 * boundaries, and pick the tallest (most complete) segment — the partial
 * second hymn at the bottom gets a small segment and is excluded. Returns null
 * for a single-hymn page (leave the default box) or if OCR finds nothing.
 */
async function detectHymnBox(
  blob: Blob,
  width: number,
  height: number
): Promise<Box | null> {
  try {
    const { createWorker } = await import("tesseract.js");
    const worker = await createWorker("eng");
    try {
      const { data } = await worker.recognize(blob, {}, { blocks: true });
      const words: OcrWord[] = [];
      for (const b of data.blocks ?? [])
        for (const p of b.paragraphs ?? [])
          for (const l of p.lines ?? [])
            for (const w of l.words ?? []) words.push(w as OcrWord);
      if (words.length < 10) return null;

      const heights = words
        .map((w) => w.bbox.y1 - w.bbox.y0)
        .filter((h) => h > 0)
        .sort((a, b) => a - b);
      const medH = heights[Math.floor(heights.length / 2)] || 1;

      const boundaries = words
        .filter(
          (w) =>
            /^\d{3}$/.test(w.text.trim()) &&
            w.bbox.y1 - w.bbox.y0 > medH * 1.6 && // large (hymn-number sized)
            w.bbox.x0 < width * 0.35 && // left margin
            w.confidence > 55
        )
        .map((w) => w.bbox.y0 / height)
        .sort((a, b) => a - b);
      if (boundaries.length === 0) return null;

      const cuts = [0, ...boundaries, 1];
      let best: [number, number] = [0, 1];
      let bestH = -1;
      for (let i = 0; i < cuts.length - 1; i++) {
        const h = cuts[i + 1] - cuts[i];
        if (h > bestH) {
          bestH = h;
          best = [cuts[i], cuts[i + 1]];
        }
      }
      const top = Math.max(0, best[0] - 0.005);
      const bot = best[1] < 1 ? best[1] - 0.012 : 0.99;
      if (bot - top > 0.9) return null; // no real split — keep the default box
      return { x: 0.02, y: top, w: 0.96, h: bot - top };
    } finally {
      await worker.terminate();
    }
  } catch {
    return null;
  }
}

/**
 * Full-screen "crop to one hymn" step. The user drags a box around the hymn
 * they actually want (an open-book photo often shows two hymns plus the facing
 * page); only that region is exported and sent to OMR — capturing intent the
 * software can't infer. Rotate handles sideways shots.
 */
export default function CropModal({
  file,
  onConfirm,
  onCancel,
}: {
  file: File;
  onConfirm: (cropped: File) => void;
  onCancel: () => void;
}) {
  const [src, setSrc] = useState("");
  const [box, setBox] = useState<Box>(INIT);
  const [hint, setHint] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);
  const urlRef = useRef<string>("");
  const blobRef = useRef<Blob | null>(null);
  const userMoved = useRef(false);
  const detected = useRef(false);
  const drag = useRef<{ mode: Mode; px: number; py: number; box: Box } | null>(null);

  // Swap in a new object URL for the working image, revoking the old one. Object
  // URLs (not data URLs) keep multi-MB images out of the DOM string.
  const swapSrc = useCallback((blob: Blob) => {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    blobRef.current = blob;
    urlRef.current = URL.createObjectURL(blob);
    setSrc(urlRef.current);
  }, []);

  // Once the image is shown, try to auto-select the intended hymn (a two-hymn
  // page is common). Runs once; never overrides a box the user already touched.
  // The box stays fully draggable afterwards so the user can fine-tune or redo.
  const onImgLoad = useCallback(async () => {
    if (detected.current) return;
    detected.current = true;
    const img = imgRef.current;
    const blob = blobRef.current;
    if (!img || !blob) return;
    setBusy(true);
    setHint("Finding the hymn for you…");
    const found = await detectHymnBox(blob, img.naturalWidth, img.naturalHeight);
    setBusy(false);
    if (userMoved.current) {
      setHint(null);
      return;
    }
    if (found) {
      setBox(found);
      setHint("Auto-selected the main hymn — fine-tune the box, or just recognize.");
    } else {
      setHint(null);
    }
  }, []);

  // Decode the file to an EXIF-corrected image so it shows upright.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
        // Cap the working image so the modal stays light (phones, screenshots);
        // ~2400px is still plenty of detail to crop a single hymn for OMR.
        const scale = Math.min(1, 2400 / Math.max(bmp.width, bmp.height));
        const c = document.createElement("canvas");
        c.width = Math.round(bmp.width * scale);
        c.height = Math.round(bmp.height * scale);
        c.getContext("2d")?.drawImage(bmp, 0, 0, c.width, c.height);
        if ("close" in bmp) bmp.close();
        c.toBlob((blob) => alive && blob && swapSrc(blob), "image/jpeg", 0.9);
      } catch {
        if (alive) swapSrc(file);
      }
    })();
    return () => {
      alive = false;
    };
  }, [file, swapSrc]);

  useEffect(
    () => () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    },
    []
  );

  const move = useCallback((e: PointerEvent) => {
    const d = drag.current;
    const img = imgRef.current;
    if (!d || !img) return;
    const r = img.getBoundingClientRect();
    const dx = (e.clientX - d.px) / r.width;
    const dy = (e.clientY - d.py) / r.height;
    let { x, y, w, h } = d.box;
    const MIN = 0.06;
    if (d.mode === "move") {
      x = Math.min(Math.max(0, x + dx), 1 - w);
      y = Math.min(Math.max(0, y + dy), 1 - h);
    } else {
      if (d.mode.includes("e")) w = Math.min(Math.max(MIN, w + dx), 1 - x);
      if (d.mode.includes("s")) h = Math.min(Math.max(MIN, h + dy), 1 - y);
      if (d.mode.includes("w")) {
        const nx = Math.min(Math.max(0, x + dx), x + w - MIN);
        w = w + x - nx;
        x = nx;
      }
      if (d.mode.includes("n")) {
        const ny = Math.min(Math.max(0, y + dy), y + h - MIN);
        h = h + y - ny;
        y = ny;
      }
    }
    setBox({ x, y, w, h });
  }, []);

  const up = useCallback(() => {
    drag.current = null;
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
  }, [move]);

  const down = (mode: Mode) => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    userMoved.current = true;
    setHint(null);
    drag.current = { mode, px: e.clientX, py: e.clientY, box };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  useEffect(
    () => () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    },
    [move, up]
  );

  const rotate = () => {
    const img = imgRef.current;
    if (!img) return;
    const c = document.createElement("canvas");
    c.width = img.naturalHeight;
    c.height = img.naturalWidth;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.translate(c.width / 2, c.height / 2);
    ctx.rotate(Math.PI / 2);
    ctx.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2);
    c.toBlob((blob) => blob && swapSrc(blob), "image/jpeg", 0.9);
    setBox(INIT);
    // Re-run hymn auto-detection on the new orientation.
    detected.current = false;
    userMoved.current = false;
    setHint(null);
  };

  const exportRegion = (b: Box) => {
    const img = imgRef.current;
    if (!img) return;
    const sx = b.x * img.naturalWidth;
    const sy = b.y * img.naturalHeight;
    const sw = Math.max(1, b.w * img.naturalWidth);
    const sh = Math.max(1, b.h * img.naturalHeight);
    const c = document.createElement("canvas");
    c.width = Math.round(sw);
    c.height = Math.round(sh);
    c.getContext("2d")?.drawImage(img, sx, sy, sw, sh, 0, 0, c.width, c.height);
    const base = file.name.replace(/\.[^.]+$/, "");
    c.toBlob(
      (blob) => {
        if (blob) onConfirm(new File([blob], `${base}.jpg`, { type: "image/jpeg" }));
      },
      "image/jpeg",
      0.92
    );
  };

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-stone-900/95"
      role="dialog"
      aria-modal="true"
    >
      <div className="flex items-center justify-between gap-2 px-4 py-3">
        <span className="flex items-center gap-2 text-sm font-bold text-white">
          Crop to one hymn
          {busy && (
            <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/30 border-t-white" />
          )}
        </span>
        <button
          onClick={onCancel}
          aria-label="Cancel"
          className="rounded-full px-3 py-1 text-2xl leading-none text-white/80 hover:text-white"
        >
          ×
        </button>
      </div>
      <p className="px-4 text-xs text-stone-300">
        {hint ?? "Drag the box around the hymn you want — only that part is recognized."}
      </p>

      <div className="flex min-h-0 flex-1 items-center justify-center p-3">
        <div className="relative inline-block touch-none">
          {src && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              ref={imgRef}
              src={src}
              alt=""
              draggable={false}
              onLoad={onImgLoad}
              className="block max-h-[64vh] max-w-full select-none"
            />
          )}
          {src && (
            <div
              className="absolute border-2 border-blue-400 bg-blue-500/15"
              style={{
                left: `${box.x * 100}%`,
                top: `${box.y * 100}%`,
                width: `${box.w * 100}%`,
                height: `${box.h * 100}%`,
                cursor: "move",
              }}
              onPointerDown={down("move")}
            >
              {(["nw", "ne", "sw", "se"] as Mode[]).map((m) => (
                <span
                  key={m}
                  onPointerDown={down(m)}
                  className="absolute h-5 w-5 rounded-full border-2 border-white bg-blue-500 shadow"
                  style={{
                    left: m.includes("w") ? -10 : "auto",
                    right: m.includes("e") ? -10 : "auto",
                    top: m.includes("n") ? -10 : "auto",
                    bottom: m.includes("s") ? -10 : "auto",
                    cursor: `${m}-resize`,
                  }}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-center gap-2.5 px-4 py-4">
        <button
          onClick={rotate}
          className="rounded-full bg-white/15 px-4 py-2.5 text-sm font-bold text-white transition-colors hover:bg-white/25"
        >
          ↻ Rotate
        </button>
        <button
          onClick={() => exportRegion({ x: 0, y: 0, w: 1, h: 1 })}
          className="rounded-full bg-white/15 px-4 py-2.5 text-sm font-bold text-white transition-colors hover:bg-white/25"
        >
          Use whole photo
        </button>
        <button
          onClick={() => exportRegion(box)}
          className="rounded-full bg-blue-600 px-6 py-2.5 text-sm font-bold text-white transition-colors hover:bg-blue-500"
        >
          Crop &amp; recognize
        </button>
      </div>
    </div>
  );
}
