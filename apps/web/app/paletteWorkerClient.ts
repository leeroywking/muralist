// Off-main-thread classifier + flatten compute.
//
// Originally implemented as a module worker via `new Worker(new URL(...,
// import.meta.url))` — that pattern works in dev but Next 15's static
// export (`output: "export"`) does not bundle the worker file, it copies
// the raw .ts source to `_next/static/media/` where the browser then
// cannot load it. Switched to a self-contained Blob URL worker so the
// classifier source ships inside the main bundle as a string and works
// regardless of build mode. Trade-off: the classifier logic is duplicated
// from packages/core into the WORKER_SOURCE string below — keep them in
// sync when modifying packages/core/src/index.ts:444+ (Phase 0 / 1 / 2 of
// classifyPaletteColors, dedupNearestNeighbors, findBestMixingPair,
// projectOntoSegment, applyClassification). Unit tests in
// packages/core/test/index.test.ts cover the canonical implementation;
// this string is intentionally a verbatim JS-equivalent of that source.

import type {
  ClassifiedColor,
  ClassifyPaletteInput,
  ClassifyPaletteOptions,
  MixRecipe
} from "@muralist/core";

export type FlattenPaletteEntry = {
  rgb: [number, number, number];
  disabled?: boolean;
};

type ClassifyRequestMessage = {
  type: "classify";
  requestId: number;
  clusters: ClassifyPaletteInput[];
  options: Omit<ClassifyPaletteOptions, "lockedIds">;
  lockedIds: string[];
};

type FlattenRequestMessage = {
  type: "flatten";
  requestId: number;
  source: Uint8ClampedArray;
  width: number;
  height: number;
  palette: FlattenPaletteEntry[];
};

type ClassifyResponseMessage = {
  type: "classify-result";
  requestId: number;
  classified: ClassifiedColor[];
  nextColors: { id: string; rgb: [number, number, number]; pixelCount: number }[];
  mixes: MixRecipe[];
  absorbedCount: number;
};

type FlattenResponseMessage = {
  type: "flatten-result";
  requestId: number;
  output: Uint8ClampedArray;
};

type WorkerResponse = ClassifyResponseMessage | FlattenResponseMessage;

const WORKER_SOURCE = `
// =========== flatten ===========
function flattenPixels(source, width, palette) {
  const out = new Uint8ClampedArray(source.length);
  const HATCH_BASE_R = 229, HATCH_BASE_G = 231, HATCH_BASE_B = 235;
  const HATCH_STROKE_R = 31, HATCH_STROKE_G = 41, HATCH_STROKE_B = 55;
  for (let i = 0; i < source.length; i += 4) {
    const alpha = source[i + 3] || 0;
    if (alpha < 128) { out[i + 3] = 0; continue; }
    const r = source[i] || 0;
    const g = source[i + 1] || 0;
    const b = source[i + 2] || 0;
    let bestIndex = 0;
    let bestDistance = Infinity;
    for (let p = 0; p < palette.length; p += 1) {
      const pr = palette[p].rgb[0], pg = palette[p].rgb[1], pb = palette[p].rgb[2];
      const dr = r - pr, dg = g - pg, db = b - pb;
      const d = dr * dr + dg * dg + db * db;
      if (d < bestDistance) { bestDistance = d; bestIndex = p; }
    }
    const best = palette[bestIndex];
    if (best.disabled) {
      const pixelIdx = i >> 2;
      const x = pixelIdx % width;
      const y = (pixelIdx - x) / width;
      const isStripe = ((x + y) % 6) < 2;
      out[i] = isStripe ? HATCH_STROKE_R : HATCH_BASE_R;
      out[i + 1] = isStripe ? HATCH_STROKE_G : HATCH_BASE_G;
      out[i + 2] = isStripe ? HATCH_STROKE_B : HATCH_BASE_B;
      out[i + 3] = 255;
    } else {
      out[i] = best.rgb[0];
      out[i + 1] = best.rgb[1];
      out[i + 2] = best.rgb[2];
      out[i + 3] = 255;
    }
  }
  return out;
}

// =========== classifier helpers ===========
function round4(value) { return Math.round(value * 1e4) / 1e4; }

function projectOntoSegment(point, a, b) {
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const denom = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2];
  if (denom <= 1e-9) return null;
  const ap = [point[0] - a[0], point[1] - a[1], point[2] - a[2]];
  const t = (ap[0] * ab[0] + ap[1] * ab[1] + ap[2] * ab[2]) / denom;
  if (t < 0 || t > 1) return null;
  const projected = [a[0] + t * ab[0], a[1] + t * ab[1], a[2] + t * ab[2]];
  const dx = point[0] - projected[0];
  const dy = point[1] - projected[1];
  const dz = point[2] - projected[2];
  const residual = Math.sqrt(dx * dx + dy * dy + dz * dz);
  return { t: t, residual: residual };
}

function findBestMixingPair(candidate, buyColors, residualThreshold) {
  if (buyColors.length < 2) return null;
  let best = null;
  for (let i = 0; i < buyColors.length; i += 1) {
    for (let j = i + 1; j < buyColors.length; j += 1) {
      const a = buyColors[i], b = buyColors[j];
      const fit = projectOntoSegment(candidate.rgb, a.rgb, b.rgb);
      if (fit === null) continue;
      if (fit.residual > residualThreshold) continue;
      const combinedPixelCount = a.pixelCount + b.pixelCount;
      if (!best ||
          fit.residual < best.residual - 1e-6 ||
          (Math.abs(fit.residual - best.residual) < 1e-6 &&
           combinedPixelCount > best.combinedPixelCount)) {
        best = { endpointA: a, endpointB: b, t: fit.t, residual: fit.residual, combinedPixelCount: combinedPixelCount };
      }
    }
  }
  if (!best) return null;
  return { endpointA: best.endpointA, endpointB: best.endpointB, t: best.t, residual: best.residual };
}

function dedupNearestNeighbors(colors, threshold, lockedIds) {
  const survivors = colors.map(function (color) { return Object.assign({}, color); });
  const absorbs = new Map();
  const isLocked = function (id) { return lockedIds ? lockedIds.has(id) : false; };
  while (survivors.length > 1) {
    let bestDistance = Infinity;
    let keeperIndex = -1, absorbedIndex = -1;
    for (let i = 0; i < survivors.length; i += 1) {
      for (let j = i + 1; j < survivors.length; j += 1) {
        const a = survivors[i], b = survivors[j];
        const aLocked = isLocked(a.id), bLocked = isLocked(b.id);
        if (aLocked && bLocked) continue;
        const dx = a.rgb[0] - b.rgb[0];
        const dy = a.rgb[1] - b.rgb[1];
        const dz = a.rgb[2] - b.rgb[2];
        const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (distance >= threshold) continue;
        if (distance < bestDistance) {
          bestDistance = distance;
          const aWins = aLocked ? true
            : bLocked ? false
            : (a.pixelCount > b.pixelCount ||
               (a.pixelCount === b.pixelCount && a.id.localeCompare(b.id) <= 0));
          if (aWins) { keeperIndex = i; absorbedIndex = j; }
          else { keeperIndex = j; absorbedIndex = i; }
        }
      }
    }
    if (bestDistance === Infinity) break;
    const keeper = survivors[keeperIndex];
    const absorbed = survivors[absorbedIndex];
    let finalKeeperId = keeper.id;
    while (absorbs.has(finalKeeperId)) finalKeeperId = absorbs.get(finalKeeperId);
    absorbs.set(absorbed.id, finalKeeperId);
    const redirectIds = [];
    for (const [id, target] of absorbs.entries()) {
      if (target === absorbed.id) redirectIds.push(id);
    }
    for (const id of redirectIds) absorbs.set(id, finalKeeperId);
    keeper.pixelCount += absorbed.pixelCount;
    survivors.splice(absorbedIndex, 1);
  }
  // Path-compress remaining chains.
  for (const id of Array.from(absorbs.keys())) {
    let target = absorbs.get(id);
    const visited = new Set([id]);
    while (absorbs.has(target) && !visited.has(target)) {
      visited.add(target);
      target = absorbs.get(target);
    }
    absorbs.set(id, target);
  }
  return { survivors: survivors, absorbs: absorbs };
}

function classifyPaletteColors(colors, options) {
  if (!isFinite(options.residualThreshold) || options.residualThreshold <= 0) {
    throw new Error("Residual threshold must be greater than zero.");
  }
  if (!isFinite(options.mixCoveragePercent) || options.mixCoveragePercent < 0) {
    throw new Error("Mix coverage percent must be zero or greater.");
  }
  const totalPixels = colors.reduce(function (s, c) { return s + c.pixelCount; }, 0);
  if (totalPixels <= 0 || colors.length === 0) return [];

  const coverageById = new Map();
  for (const color of colors) {
    coverageById.set(color.id, (color.pixelCount / totalPixels) * 100);
  }

  const dedupResult = dedupNearestNeighbors(colors, options.residualThreshold, options.lockedIds);
  const survivors = dedupResult.survivors;
  const dedupAbsorbs = dedupResult.absorbs;
  if (survivors.length === 0) {
    return colors.map(function (color) {
      return { id: color.id, classification: "absorb", absorbedIntoId: dedupAbsorbs.get(color.id) || color.id };
    });
  }

  // Phase 1: extremes
  const extremeIds = new Set();
  for (const candidate of survivors) {
    const others = survivors.filter(function (c) { return c.id !== candidate.id; });
    const fit = findBestMixingPair(candidate, others, options.residualThreshold);
    if (!fit) extremeIds.add(candidate.id);
  }
  if (extremeIds.size === 0) {
    let topId = null, topPixels = -Infinity;
    for (const c of survivors) {
      if (c.pixelCount > topPixels) { topPixels = c.pixelCount; topId = c.id; }
    }
    if (topId) extremeIds.add(topId);
  }
  const extremes = survivors.filter(function (c) { return extremeIds.has(c.id); });

  // Phase 2 coverage
  const adjustedPixelsById = new Map();
  for (const s of survivors) adjustedPixelsById.set(s.id, s.pixelCount);
  for (const [absorbedId, keeperId] of dedupAbsorbs.entries()) {
    const absorbed = colors.find(function (c) { return c.id === absorbedId; });
    if (!absorbed) continue;
    adjustedPixelsById.set(keeperId, (adjustedPixelsById.get(keeperId) || 0) + absorbed.pixelCount);
  }
  let adjustedTotal = 0;
  for (const v of adjustedPixelsById.values()) adjustedTotal += v;
  const adjustedCoverageById = new Map();
  if (adjustedTotal > 0) {
    for (const [id, pixels] of adjustedPixelsById.entries()) {
      adjustedCoverageById.set(id, (pixels / adjustedTotal) * 100);
    }
  }

  const classifications = new Map();
  for (const color of survivors) {
    if (extremeIds.has(color.id)) {
      classifications.set(color.id, { id: color.id, classification: "buy" });
      continue;
    }
    const fit = findBestMixingPair(color, extremes, options.residualThreshold);
    if (!fit) {
      classifications.set(color.id, { id: color.id, classification: "buy" });
      continue;
    }
    const coverage = adjustedCoverageById.get(color.id) || coverageById.get(color.id) || 0;
    if (coverage >= options.mixCoveragePercent) {
      classifications.set(color.id, {
        id: color.id, classification: "mix",
        recipe: {
          targetColorId: color.id,
          components: [
            { colorId: fit.endpointA.id, fraction: round4(1 - fit.t) },
            { colorId: fit.endpointB.id, fraction: round4(fit.t) }
          ]
        }
      });
    } else if (options.lockedIds && options.lockedIds.has(color.id)) {
      classifications.set(color.id, { id: color.id, classification: "buy" });
    } else {
      classifications.set(color.id, {
        id: color.id, classification: "absorb",
        absorbedIntoId: fit.t < 0.5 ? fit.endpointA.id : fit.endpointB.id
      });
    }
  }
  for (const [absorbedId, keeperId] of dedupAbsorbs.entries()) {
    classifications.set(absorbedId, { id: absorbedId, classification: "absorb", absorbedIntoId: keeperId });
  }

  // Path compression
  for (const [id, entry] of classifications.entries()) {
    if (entry.classification !== "absorb" || !entry.absorbedIntoId) continue;
    let target = entry.absorbedIntoId;
    const visited = new Set([id]);
    while (!visited.has(target)) {
      visited.add(target);
      const next = classifications.get(target);
      if (!next || next.classification !== "absorb" || !next.absorbedIntoId) break;
      target = next.absorbedIntoId;
    }
    if (target !== entry.absorbedIntoId) {
      classifications.set(id, Object.assign({}, entry, { absorbedIntoId: target }));
    }
  }
  return colors.map(function (color) { return classifications.get(color.id); });
}

function applyClassification(colors, classifications) {
  const classificationById = new Map();
  for (const entry of classifications) classificationById.set(entry.id, entry);
  const pixelCountById = new Map();
  for (const color of colors) pixelCountById.set(color.id, color.pixelCount);
  let absorbedCount = 0;
  for (const color of colors) {
    const entry = classificationById.get(color.id);
    if (!entry || entry.classification !== "absorb" || !entry.absorbedIntoId) continue;
    const keeperPixels = pixelCountById.get(entry.absorbedIntoId);
    if (keeperPixels === undefined) {
      throw new Error("Absorbed color " + color.id + " references unknown keeper " + entry.absorbedIntoId + ".");
    }
    pixelCountById.set(entry.absorbedIntoId, keeperPixels + color.pixelCount);
    pixelCountById.delete(color.id);
    absorbedCount += 1;
  }
  const nextColors = [];
  const mixes = [];
  for (const color of colors) {
    const entry = classificationById.get(color.id);
    if (!entry) { nextColors.push(color); continue; }
    if (entry.classification === "absorb") continue;
    const updatedPixelCount = pixelCountById.get(color.id);
    if (updatedPixelCount === undefined) continue;
    nextColors.push(Object.assign({}, color, { pixelCount: updatedPixelCount }));
    if (entry.classification === "mix" && entry.recipe) mixes.push(entry.recipe);
  }
  return { nextColors: nextColors, mixes: mixes, absorbedCount: absorbedCount };
}

// =========== message dispatch ===========
self.onmessage = function (event) {
  const msg = event.data;
  if (msg.type === "classify") {
    const options = Object.assign({}, msg.options);
    if (msg.lockedIds && msg.lockedIds.length > 0) options.lockedIds = new Set(msg.lockedIds);
    const classified = classifyPaletteColors(msg.clusters, options);
    const applied = applyClassification(msg.clusters, classified);
    self.postMessage({
      type: "classify-result", requestId: msg.requestId,
      classified: classified, nextColors: applied.nextColors,
      mixes: applied.mixes, absorbedCount: applied.absorbedCount
    });
    return;
  }
  if (msg.type === "flatten") {
    const output = flattenPixels(msg.source, msg.width, msg.palette);
    self.postMessage({ type: "flatten-result", requestId: msg.requestId, output: output }, [output.buffer]);
    return;
  }
};
`;

let workerInstance: Worker | null = null;
let workerBlobUrl: string | null = null;
let nextRequestId = 0;
const pending = new Map<
  number,
  {
    resolve: (data: WorkerResponse) => void;
    reject: (err: Error) => void;
  }
>();

function ensureWorker(): Worker {
  if (workerInstance) return workerInstance;
  if (typeof window === "undefined") {
    throw new Error("Palette worker requires a browser environment.");
  }
  const blob = new Blob([WORKER_SOURCE], { type: "application/javascript" });
  workerBlobUrl = URL.createObjectURL(blob);
  workerInstance = new Worker(workerBlobUrl);
  workerInstance.onmessage = (event: MessageEvent<WorkerResponse>) => {
    const { requestId } = event.data;
    const entry = pending.get(requestId);
    if (!entry) return;
    pending.delete(requestId);
    entry.resolve(event.data);
  };
  workerInstance.onerror = (err) => {
    const detail = [
      err.message,
      err.filename ? `at ${err.filename}:${err.lineno}:${err.colno}` : null
    ]
      .filter(Boolean)
      .join(" ");
    for (const [id, entry] of pending) {
      entry.reject(new Error(`Palette worker error: ${detail || "unknown"}`));
      pending.delete(id);
    }
  };
  return workerInstance;
}

export type ClassifyResult = Omit<ClassifyResponseMessage, "type" | "requestId">;
export type FlattenResult = Omit<FlattenResponseMessage, "type" | "requestId">;

export function requestClassify(
  clusters: ClassifyPaletteInput[],
  options: Omit<ClassifyPaletteOptions, "lockedIds">,
  lockedIds: Iterable<string>
): Promise<ClassifyResult> {
  const worker = ensureWorker();
  const requestId = ++nextRequestId;
  return new Promise<ClassifyResult>((resolve, reject) => {
    pending.set(requestId, {
      resolve: (data) => {
        if (data.type !== "classify-result") {
          reject(new Error(`Unexpected response type: ${data.type}`));
          return;
        }
        const { type: _t, requestId: _r, ...rest } = data;
        resolve(rest);
      },
      reject
    });
    const message: ClassifyRequestMessage = {
      type: "classify",
      requestId,
      clusters,
      options,
      lockedIds: Array.from(lockedIds)
    };
    worker.postMessage(message);
  });
}

export function requestFlatten(
  source: Uint8ClampedArray,
  width: number,
  height: number,
  palette: FlattenPaletteEntry[]
): Promise<FlattenResult> {
  const worker = ensureWorker();
  const requestId = ++nextRequestId;
  return new Promise<FlattenResult>((resolve, reject) => {
    pending.set(requestId, {
      resolve: (data) => {
        if (data.type !== "flatten-result") {
          reject(new Error(`Unexpected response type: ${data.type}`));
          return;
        }
        const { type: _t, requestId: _r, ...rest } = data;
        resolve(rest);
      },
      reject
    });
    const message: FlattenRequestMessage = {
      type: "flatten",
      requestId,
      source,
      width,
      height,
      palette
    };
    worker.postMessage(message);
  });
}

// Cleanup utility for tests / hot-reload scenarios. Not called during
// normal use — the worker outlives the component.
export function terminatePaletteWorker(): void {
  if (workerInstance) {
    workerInstance.terminate();
    workerInstance = null;
  }
  if (workerBlobUrl) {
    URL.revokeObjectURL(workerBlobUrl);
    workerBlobUrl = null;
  }
}
