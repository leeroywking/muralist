// Main-thread side of the browser-independent analysis pipeline: reads the
// file's bytes, hands them to the analysis worker (imageAnalysis.ts running in
// analysisWorker.ts), and encodes the reduced preview without a canvas.
//
// PRODUCT RULE (user, 2026-10-12): "I don't want the browser-modified file in
// our key path at all. If what is rendered to the user contains privacy noise
// that's fine, as long as we aren't running calculations against it."
// Canvas is display-only. The single exception is SVG (below).

import { encode as encodePng } from "fast-png";
import {
  flattenPixelsToPalette,
  prepareAnalysisImage,
  surveyPalette,
  type FlattenPaletteColor,
  type RgbaImage
} from "@muralist/core";
import type { AnalysisMode, ImageAnalysisResult, RasterFormat } from "./imageAnalysis";
import type { AnalysisWorkerRequest, AnalysisWorkerResponse } from "./analysisWorker";
import { rasterizeSvgToBitmap, verifyMagicBytes } from "./uploadPipeline";

export type AnalysisRun = Omit<ImageAnalysisResult, "format"> & {
  format: RasterFormat | "svg";
  via: "worker" | "svg-canvas";
};

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (r: ImageAnalysisResult) => void; reject: (e: Error) => void }>();

// No main-thread fallback on purpose: Web Workers are universal on supported
// browsers, and a silent fallback would hide a broken worker build on deploy.
function getWorker(): Worker {
  if (worker) return worker;
  // Keep `new URL(...)` inline in the `new Worker(...)` call: webpack only
  // bundles the worker entry for this exact shape.
  // @ts-expect-error import.meta.url is rewritten by the Next/webpack bundler; the shared NodeNext tsconfig types this file as CommonJS.
  worker = new Worker(new URL("./analysisWorker.ts", import.meta.url));
  worker.onmessage = (event: MessageEvent<AnalysisWorkerResponse>) => {
    const message = event.data;
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.ok) entry.resolve(message.result);
    else entry.reject(new Error(message.error));
  };
  worker.onerror = (event) => {
    // The worker script itself failed (load/parse/uncaught) — not an
    // analysis error, which comes back as { ok: false }.
    worker?.terminate();
    worker = null;
    for (const [id, entry] of pending) {
      pending.delete(id);
      entry.reject(new Error(`Image analysis worker failed: ${event.message || "unknown error"}`));
    }
  };
  return worker;
}

/** Run the analysis pipeline on raster bytes (JPEG/PNG/WebP) in the worker. */
export async function analyzeRasterBytes(bytes: Uint8Array, mode: AnalysisMode): Promise<AnalysisRun> {
  const active = getWorker();
  return new Promise<AnalysisRun>((resolve, reject) => {
    const id = nextId;
    nextId += 1;
    pending.set(id, {
      resolve: (result) => resolve({ ...result, via: "worker" }),
      reject
    });
    const copy = bytes.slice().buffer;
    const request: AnalysisWorkerRequest = { id, bytes: copy, mode };
    active.postMessage(request, [copy]);
  });
}

/**
 * SVG — THE ONE REMAINING EXCEPTION to the no-canvas rule. There is no
 * browser-free SVG rasterizer short of a heavy dependency (resvg-wasm,
 * MPL-2.0; proposed as a follow-up), so SVG is rasterized by the existing
 * isolated-<img> path and read back from an sRGB canvas. Its palette can
 * differ between browsers (and under canvas privacy noise). Everything after
 * the readback (downscale, survey) is the shared core pipeline.
 */
async function analyzeSvgViaCanvas(file: Blob, mode: AnalysisMode): Promise<AnalysisRun> {
  const start = performance.now();
  const bitmap = await rasterizeSvgToBitmap(file, 640);
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext("2d", { colorSpace: "srgb", willReadFrequently: true });
    if (!ctx) throw new Error("2D canvas context is unavailable.");
    ctx.drawImage(bitmap, 0, 0);
    const readback = ctx.getImageData(0, 0, bitmap.width, bitmap.height, { colorSpace: "srgb" });
    const decodedAt = performance.now();
    const prepared = prepareAnalysisImage(
      { data: readback.data, width: readback.width, height: readback.height },
      { iccProfile: null, orientation: 1 }
    );
    const survey = mode === "survey" ? surveyPalette(prepared.image) : null;
    const end = performance.now();
    return {
      format: "svg",
      pixels: prepared.image,
      survey,
      color: { status: "untagged", profileDescription: null, note: null },
      sourceWidth: prepared.sourceWidth,
      sourceHeight: prepared.sourceHeight,
      timingsMs: { decode: decodedAt - start, prepare: end - decodedAt, total: end - start },
      via: "svg-canvas"
    };
  } finally {
    bitmap.close();
  }
}

declare global {
  interface Window {
    /** Last analysis run, for diagnostics and cross-browser verification. */
    __muralistAnalysis?: { via: AnalysisRun["via"]; format: string; color: string; timingsMs: AnalysisRun["timingsMs"] };
  }
}

/** Analyze an uploaded (or stored) image from its bytes. */
export async function analyzeImageFile(file: Blob, mode: AnalysisMode = "survey"): Promise<AnalysisRun> {
  const kind = await verifyMagicBytes(file);
  const run =
    kind === "svg"
      ? await analyzeSvgViaCanvas(file, mode)
      : await analyzeRasterBytes(new Uint8Array(await file.arrayBuffer()), mode);
  if (typeof window !== "undefined") {
    window.__muralistAnalysis = { via: run.via, format: run.format, color: run.color.status, timingsMs: run.timingsMs };
  }
  return run;
}

/** Decode a `data:` URL's base64 payload to a Blob without fetch or <img>. */
export function dataUrlToBlob(dataUrl: string): Blob {
  const comma = dataUrl.indexOf(",");
  const header = dataUrl.slice(5, comma);
  const binary = atob(dataUrl.slice(comma + 1));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: header.split(";")[0] || "application/octet-stream" });
}

/**
 * Reduced preview: map our analysis pixels to the palette (core) and encode
 * the PNG with fast-png — no canvas readback or toDataURL, so the maquette's
 * reduced image is byte-identical across browsers too.
 */
export function flattenToPngDataUrl(
  source: RgbaImage,
  palette: readonly FlattenPaletteColor[],
  transparentColorIds: ReadonlySet<string>
): string | null {
  const flat = flattenPixelsToPalette(source, palette, transparentColorIds);
  if (!flat) return null;
  const png = encodePng({ width: source.width, height: source.height, data: flat, channels: 4, depth: 8 });
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < png.length; i += chunk) {
    binary += String.fromCharCode(...png.subarray(i, i + chunk));
  }
  return `data:image/png;base64,${btoa(binary)}`;
}
