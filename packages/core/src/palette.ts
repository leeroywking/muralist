// Palette survey (initial color extraction) and the flatten-to-palette mapping
// behind the reduced preview. Moved verbatim from apps/web PrototypeApp.tsx so
// they run on our own decoded pixels in a worker, in Node, and in tests — never
// on a canvas readback (see the product rule at the top of ./icc.ts).

import type { RgbaImage } from "./raster.js";

export type SurveyColor = {
  id: string;
  hex: string;
  rgb: [number, number, number];
  pixelCount: number;
  coveragePercent: number;
};

export type PaletteSurvey = {
  width: number;
  height: number;
  colors: SurveyColor[];
};

/** Upper bound on surveyed pixels (strided sample of the analysis image). */
export const SURVEY_MAX_SAMPLE_PIXELS = 22000;
// Initial-survey palette reduction is by *color difference*, not popularity.
// Buckets closer than this Euclidean RGB distance fold together; anything more
// distinct is kept regardless of how little of the image it covers — so small,
// vivid regions (a flower's yellow center) survive instead of being cut by a
// top-N popularity slice. 24 sits just above the /12 quantization floor.
// (Auto-combine thresholds are OKLab distances, not these RGB units.)
export const SURVEY_MIN_COLOR_DISTANCE = 24;

type Cluster = {
  rgb: [number, number, number];
  pixelCount: number;
};

/**
 * Cluster a raw RGBA pixel buffer into the original palette. Pure and
 * deterministic (integer math + sqrt, which IEEE rounds identically in every
 * engine). Throws when no pixel is at least half opaque.
 */
export function surveyPalette(image: RgbaImage): PaletteSurvey {
  const sampled = samplePixels(image.data);

  if (!sampled.length) {
    throw new Error("No visible pixels were found in this image.");
  }

  const initialClusters = bucketPixels(sampled);
  const distinctClusters = clusterByColorDistance(initialClusters, SURVEY_MIN_COLOR_DISTANCE);
  const colors = rebalanceCoverage(
    distinctClusters
      .sort((left, right) => right.pixelCount - left.pixelCount)
      .map((cluster, index) => ({
        id: `color-${index + 1}`,
        hex: rgbToHex(cluster.rgb),
        rgb: cluster.rgb,
        pixelCount: cluster.pixelCount,
        coveragePercent: 0
      }))
  );

  return { width: image.width, height: image.height, colors };
}

function rebalanceCoverage(colors: SurveyColor[]): SurveyColor[] {
  const totalPixels = colors.reduce((sum, color) => sum + color.pixelCount, 0);

  return colors.map((color) => ({
    ...color,
    coveragePercent: totalPixels > 0 ? (color.pixelCount / totalPixels) * 100 : 0
  }));
}

function samplePixels(data: Uint8ClampedArray | Uint8Array) {
  const totalPixels = data.length / 4;
  const step = Math.max(1, Math.floor(totalPixels / SURVEY_MAX_SAMPLE_PIXELS));
  const pixels: [number, number, number][] = [];

  for (let index = 0; index < data.length; index += 4 * step) {
    const alpha = data[index + 3] ?? 0;

    if (alpha < 128) {
      continue;
    }

    pixels.push([data[index] ?? 0, data[index + 1] ?? 0, data[index + 2] ?? 0]);
  }

  return pixels;
}

function bucketPixels(pixels: [number, number, number][]) {
  const buckets = new Map<string, Cluster>();

  for (const pixel of pixels) {
    const quantized: [number, number, number] = [
      quantizeChannel(pixel[0]),
      quantizeChannel(pixel[1]),
      quantizeChannel(pixel[2])
    ];
    const key = quantized.join("-");
    const existing = buckets.get(key);

    if (existing) {
      existing.pixelCount += 1;
      existing.rgb = weightedAverage(existing.rgb, existing.pixelCount - 1, pixel, 1);
      continue;
    }

    buckets.set(key, {
      rgb: pixel,
      pixelCount: 1
    });
  }

  return Array.from(buckets.values());
}

// Reduce raw quantized buckets to a palette by color difference, not coverage.
// Walk buckets from most to least common; keep each one that is at least
// `minDistance` (Euclidean RGB) from every color already kept, otherwise fold
// its pixels into the nearest kept color. There is no popularity cut — a small
// but distinct color survives because it is far from everything else, however
// little of the image it covers. Count-ordered so the dominant color in each
// neighborhood becomes its representative. O(N·K), N = buckets, K = kept.
function clusterByColorDistance(clusters: Cluster[], minDistance: number): Cluster[] {
  const kept: Cluster[] = [];

  for (const cluster of [...clusters].sort((left, right) => right.pixelCount - left.pixelCount)) {
    let nearest: Cluster | null = null;
    let nearestDistance = Infinity;

    for (const candidate of kept) {
      const dx = candidate.rgb[0] - cluster.rgb[0];
      const dy = candidate.rgb[1] - cluster.rgb[1];
      const dz = candidate.rgb[2] - cluster.rgb[2];
      const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearest = candidate;
      }
    }

    if (nearest && nearestDistance < minDistance) {
      nearest.pixelCount += cluster.pixelCount;
    } else {
      kept.push({ rgb: [...cluster.rgb], pixelCount: cluster.pixelCount });
    }
  }

  return kept;
}

function quantizeChannel(channel: number) {
  return Math.round(channel / 12) * 12;
}

function weightedAverage(
  left: [number, number, number],
  leftWeight: number,
  right: [number, number, number],
  rightWeight: number
): [number, number, number] {
  const totalWeight = leftWeight + rightWeight;

  return [
    Math.round((left[0] * leftWeight + right[0] * rightWeight) / totalWeight),
    Math.round((left[1] * leftWeight + right[1] * rightWeight) / totalWeight),
    Math.round((left[2] * leftWeight + right[2] * rightWeight) / totalWeight)
  ];
}

export function rgbToHex([red, green, blue]: readonly [number, number, number]): string {
  return `#${[red, green, blue].map((channel) => channel.toString(16).padStart(2, "0")).join("")}`.toUpperCase();
}

export type FlattenPaletteColor = {
  id: string;
  rgb: readonly [number, number, number];
};

/**
 * Map every pixel to its nearest palette color (the reduced preview / maquette
 * image). Pixels under half alpha, and pixels whose nearest color is marked
 * transparent (bare wall), come out fully transparent. sRGB Euclidean is close
 * enough for paint-by-numbers flattening and avoids a Lab conversion per pixel.
 * Returns RGBA bytes the size of the source; empty palette -> null.
 */
export function flattenPixelsToPalette(
  source: RgbaImage,
  palette: readonly FlattenPaletteColor[],
  transparentColorIds: ReadonlySet<string> = new Set()
): Uint8ClampedArray | null {
  if (palette.length === 0) return null;
  const data = source.data;
  const out = new Uint8ClampedArray(data.length);
  for (let i = 0; i < data.length; i += 4) {
    const alpha = data[i + 3] ?? 0;
    if (alpha < 128) {
      out[i + 3] = 0;
      continue;
    }
    const r = data[i] ?? 0;
    const g = data[i + 1] ?? 0;
    const b = data[i + 2] ?? 0;
    let bestIndex = 0;
    let bestDistance = Infinity;
    for (let p = 0; p < palette.length; p += 1) {
      const [pr, pg, pb] = palette[p]!.rgb;
      const dr = r - pr;
      const dg = g - pg;
      const db = b - pb;
      const d = dr * dr + dg * dg + db * db;
      if (d < bestDistance) {
        bestDistance = d;
        bestIndex = p;
      }
    }
    const nearest = palette[bestIndex]!;
    if (transparentColorIds.has(nearest.id)) {
      out[i + 3] = 0;
      continue;
    }
    out[i] = nearest.rgb[0];
    out[i + 1] = nearest.rgb[1];
    out[i + 2] = nearest.rgb[2];
    out[i + 3] = 255;
  }
  return out;
}
