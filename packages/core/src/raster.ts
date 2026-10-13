// Pure raster helpers for the analysis pipeline: container metadata (embedded
// ICC profile, EXIF orientation), a deterministic box-filter downscale, and
// EXIF orientation transforms. No DOM, no canvas — see the product rule at the
// top of ./icc.ts. Browsers resample with drawImage using engine-specific
// filters, so the analysis-size image is produced here instead.

export type RgbaImage = {
  /** Non-premultiplied RGBA, 4 bytes per pixel, row-major. */
  data: Uint8ClampedArray;
  width: number;
  height: number;
};

export type ImageContainerMetadata = {
  iccProfile: Uint8Array | null;
  /** EXIF orientation 1..8 (1 = as stored). */
  orientation: number;
};

/**
 * Long-edge cap of the analysis image (palette survey, coverage, reduced
 * preview). Unchanged from the canvas-era `maxDimension`.
 */
export const ANALYSIS_MAX_DIMENSION = 320;

/** Same rounding the canvas-era `getScaledDimensions` used. Never upscales. */
export function getAnalysisDimensions(
  width: number,
  height: number,
  maxDimension: number = ANALYSIS_MAX_DIMENSION
): { width: number; height: number } {
  const scale = Math.min(1, maxDimension / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale))
  };
}

/**
 * Read the embedded ICC profile (APP2 "ICC_PROFILE" chunks, reassembled in
 * sequence order) and EXIF orientation (APP1 "Exif") from a JPEG's marker
 * segments. Stops at the first SOS; never throws on malformed input.
 */
export function readJpegMetadata(bytes: Uint8Array): ImageContainerMetadata {
  const iccChunks = new Map<number, Uint8Array>();
  let orientation = 1;
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) break;
    const marker = bytes[offset + 1]!;
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      offset += 2;
      continue;
    }
    if (marker === 0xda || marker === 0xd9) break;
    const length = (bytes[offset + 2]! << 8) | bytes[offset + 3]!;
    const start = offset + 4;
    const end = offset + 2 + length;
    if (length < 2 || end > bytes.length) break;
    if (marker === 0xe2 && matchesAscii(bytes, start, "ICC_PROFILE\0") && end - start >= 14) {
      const sequence = bytes[start + 12]!;
      iccChunks.set(sequence, bytes.subarray(start + 14, end));
    } else if (marker === 0xe1 && matchesAscii(bytes, start, "Exif\0\0")) {
      orientation = readExifOrientation(bytes.subarray(start + 6, end));
    }
    offset = end;
  }
  return { iccProfile: joinChunks(iccChunks), orientation };
}

/** Read the ICCP and EXIF chunks of a (VP8X extended) WebP RIFF container. */
export function readWebpMetadata(bytes: Uint8Array): ImageContainerMetadata {
  let iccProfile: Uint8Array | null = null;
  let orientation = 1;
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const fourcc = String.fromCharCode(bytes[offset]!, bytes[offset + 1]!, bytes[offset + 2]!, bytes[offset + 3]!);
    const size =
      (bytes[offset + 4]! | (bytes[offset + 5]! << 8) | (bytes[offset + 6]! << 16) | (bytes[offset + 7]! << 24)) >>> 0;
    const start = offset + 8;
    const end = start + size;
    if (end > bytes.length) break;
    if (fourcc === "ICCP") iccProfile = bytes.subarray(start, end);
    if (fourcc === "EXIF") {
      const payload = bytes.subarray(start, end);
      orientation = readExifOrientation(
        matchesAscii(payload, 0, "Exif\0\0") ? payload.subarray(6) : payload
      );
    }
    offset = end + (size & 1);
  }
  return { iccProfile, orientation };
}

/** EXIF orientation (tag 0x0112) from a TIFF-structured EXIF payload; 1 when absent or invalid. */
export function readExifOrientation(tiff: Uint8Array): number {
  if (tiff.length < 8) return 1;
  const little = tiff[0] === 0x49 && tiff[1] === 0x49;
  const big = tiff[0] === 0x4d && tiff[1] === 0x4d;
  if (!little && !big) return 1;
  const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
  const ifd = view.getUint32(4, little);
  if (ifd + 2 > tiff.length) return 1;
  const count = view.getUint16(ifd, little);
  for (let i = 0; i < count; i += 1) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > tiff.length) break;
    if (view.getUint16(entry, little) === 0x0112) {
      const value = view.getUint16(entry + 8, little);
      return value >= 1 && value <= 8 ? value : 1;
    }
  }
  return 1;
}

function matchesAscii(bytes: Uint8Array, offset: number, text: string): boolean {
  if (offset + text.length > bytes.length) return false;
  for (let i = 0; i < text.length; i += 1) {
    if (bytes[offset + i] !== text.charCodeAt(i)) return false;
  }
  return true;
}

function joinChunks(chunks: Map<number, Uint8Array>): Uint8Array | null {
  if (chunks.size === 0) return null;
  const ordered = [...chunks.entries()].sort((a, b) => a[0] - b[0]).map(([, chunk]) => chunk);
  const total = ordered.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let position = 0;
  for (const chunk of ordered) {
    out.set(chunk, position);
    position += chunk.length;
  }
  return out;
}

/** True when EXIF orientation swaps width and height (5..8 are the transposing ones). */
export function orientationSwapsAxes(orientation: number): boolean {
  return orientation >= 5 && orientation <= 8;
}

/**
 * Apply an EXIF orientation so the result is upright, matching what browsers
 * display (`image-orientation: from-image`). Pure index remapping.
 */
export function applyExifOrientation(image: RgbaImage, orientation: number): RgbaImage {
  if (orientation <= 1 || orientation > 8) return image;
  const { width: w, height: h, data } = image;
  const swap = orientationSwapsAxes(orientation);
  const outWidth = swap ? h : w;
  const outHeight = swap ? w : h;
  const out = new Uint8ClampedArray(outWidth * outHeight * 4);
  for (let y = 0; y < outHeight; y += 1) {
    for (let x = 0; x < outWidth; x += 1) {
      // (sx, sy): the stored pixel that lands at upright (x, y).
      let sx: number;
      let sy: number;
      switch (orientation) {
        case 2: sx = w - 1 - x; sy = y; break; // mirror horizontal
        case 3: sx = w - 1 - x; sy = h - 1 - y; break; // rotate 180
        case 4: sx = x; sy = h - 1 - y; break; // mirror vertical
        case 5: sx = y; sy = x; break; // transpose
        case 6: sx = y; sy = h - 1 - x; break; // rotate 90 CW
        case 7: sx = w - 1 - y; sy = h - 1 - x; break; // transverse
        default: sx = w - 1 - y; sy = x; break; // 8: rotate 90 CCW
      }
      const from = (sy * w + sx) * 4;
      const to = (y * outWidth + x) * 4;
      out[to] = data[from]!;
      out[to + 1] = data[from + 1]!;
      out[to + 2] = data[from + 2]!;
      out[to + 3] = data[from + 3]!;
    }
  }
  return { data: out, width: outWidth, height: outHeight };
}

/**
 * Deterministic area-average (box filter) downscale with exact fractional
 * coverage.
 *
 * Map source and target onto a common integer grid: source pixel i spans
 * [i*W, (i+1)*W) and target pixel j spans [j*w, (j+1)*w) along an axis
 * (w = source size, W = target size). Every overlap is then an integer, so
 * each target pixel is an exact integer-weighted average of the source pixels
 * it covers — no resampling kernel, no float rounding drift. Colors are
 * alpha-weighted (premultiplied) so transparent pixels don't darken edges; the
 * sums stay below 2^53 for any image up to ~100 MP, so every step is exact
 * IEEE integer arithmetic and the final round-half-up is identical in every
 * JS engine. Averaging is in encoded sRGB, like the canvas path it replaces.
 * Upscaling is not supported (target must be <= source on both axes).
 */
export function downscaleBoxRgba(image: RgbaImage, targetWidth: number, targetHeight: number): RgbaImage {
  const { width: w, height: h, data } = image;
  const W = targetWidth;
  const H = targetHeight;
  if (W > w || H > h || W < 1 || H < 1) {
    throw new Error(`downscaleBoxRgba: target ${W}x${H} must be within 1..${w}x${h}.`);
  }
  if (W === w && H === h) {
    return { data: new Uint8ClampedArray(data), width: w, height: h };
  }
  // Horizontal spans: for source column i, the (at most two-or-more) target
  // columns it overlaps, with integer weights.
  const colTarget: number[][] = [];
  const colWeight: number[][] = [];
  for (let i = 0; i < w; i += 1) {
    const start = i * W;
    const end = start + W;
    const targets: number[] = [];
    const weights: number[] = [];
    for (let j = Math.floor(start / w); j < W && j * w < end; j += 1) {
      const overlap = Math.min(end, (j + 1) * w) - Math.max(start, j * w);
      if (overlap > 0) {
        targets.push(j);
        weights.push(overlap);
      }
    }
    colTarget.push(targets);
    colWeight.push(weights);
  }

  // Accumulators for every target row: premultiplied r, g, b and alpha sums.
  const acc = new Float64Array(W * H * 4);
  const rowSums = new Float64Array(W * 4);
  for (let sy = 0; sy < h; sy += 1) {
    rowSums.fill(0);
    const rowBase = sy * w * 4;
    for (let sx = 0; sx < w; sx += 1) {
      const p = rowBase + sx * 4;
      const a = data[p + 3]!;
      if (a === 0) continue;
      const r = data[p]! * a;
      const g = data[p + 1]! * a;
      const b = data[p + 2]! * a;
      const targets = colTarget[sx]!;
      const weights = colWeight[sx]!;
      for (let k = 0; k < targets.length; k += 1) {
        const q = targets[k]! * 4;
        const wx = weights[k]!;
        rowSums[q] = rowSums[q]! + r * wx;
        rowSums[q + 1] = rowSums[q + 1]! + g * wx;
        rowSums[q + 2] = rowSums[q + 2]! + b * wx;
        rowSums[q + 3] = rowSums[q + 3]! + a * wx;
      }
    }
    const start = sy * H;
    const end = start + H;
    for (let ty = Math.floor(start / h); ty < H && ty * h < end; ty += 1) {
      const wy = Math.min(end, (ty + 1) * h) - Math.max(start, ty * h);
      if (wy <= 0) continue;
      const base = ty * W * 4;
      for (let q = 0; q < W * 4; q += 1) acc[base + q] = acc[base + q]! + rowSums[q]! * wy;
    }
  }

  const out = new Uint8ClampedArray(W * H * 4);
  const area = w * h; // total weight of every target pixel (w per axis-x, h per axis-y)
  for (let t = 0; t < W * H; t += 1) {
    const q = t * 4;
    const alphaSum = acc[q + 3]!;
    if (alphaSum === 0) continue;
    out[q] = roundDiv(acc[q]!, alphaSum);
    out[q + 1] = roundDiv(acc[q + 1]!, alphaSum);
    out[q + 2] = roundDiv(acc[q + 2]!, alphaSum);
    out[q + 3] = roundDiv(alphaSum, area);
  }
  return { data: out, width: W, height: H };
}

/** round(numerator / denominator), half up, for non-negative exact integers. */
function roundDiv(numerator: number, denominator: number): number {
  return Math.floor((2 * numerator + denominator) / (2 * denominator));
}
