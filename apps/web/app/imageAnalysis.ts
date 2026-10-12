// Browser-independent image analysis: our own decode of the file's bytes,
// then the pure @muralist/core pipeline (ICC -> sRGB, box downscale, EXIF
// orientation, palette survey).
//
// PRODUCT RULE (user, 2026-10-12): "I don't want the browser-modified file in
// our key path at all. If what is rendered to the user contains privacy noise
// that's fine, as long as we aren't running calculations against it."
// So NOTHING in this module touches a canvas, ImageBitmap, <img> or any other
// browser decode/readback: browsers color-manage embedded profiles
// differently, resample drawImage with different filters, round JPEG IDCTs
// differently, and privacy modes (Safari AFP, Brave, Firefox RFP) add noise to
// getImageData. Canvas is display-only. This module is DOM-free on purpose — it
// runs in a Web Worker in the app, and in Node for tests and
// scripts/analyze-file.ts, which must print the exact palette the app shows.
//
// Formats: JPEG (jpeg-js), PNG (fast-png), WebP (@jsquash/webp, WASM). SVG is
// the one remaining exception (no browser-free rasterizer without a heavy
// dependency) and never reaches this module — see analysisClient.ts.

import { decode as decodeJpegBytes } from "jpeg-js";
import { convertIndexedToRgb, decode as decodePngBytes, type DecodedPng } from "fast-png";
import {
  analyzeDecodedImage,
  prepareAnalysisImage,
  readJpegMetadata,
  readWebpMetadata,
  type ImageContainerMetadata,
  type PaletteSurvey,
  type RgbaImage,
  type SrgbConversionResult
} from "@muralist/core";

export type RasterFormat = "jpeg" | "png" | "webp";

export type DecodedRaster = {
  format: RasterFormat;
  image: RgbaImage;
  metadata: ImageContainerMetadata;
};

export function detectRasterFormat(bytes: Uint8Array): RasterFormat | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) {
    return "png";
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return "webp";
  }
  return null;
}

function decodeJpeg(bytes: Uint8Array): DecodedRaster {
  const decoded = decodeJpegBytes(bytes, {
    useTArray: true,
    formatAsRGBA: true,
    tolerantDecoding: true,
    maxResolutionInMP: 100,
    maxMemoryUsageInMB: 1024
  });
  return {
    format: "jpeg",
    image: {
      data: new Uint8ClampedArray(decoded.data.buffer, decoded.data.byteOffset, decoded.data.byteLength),
      width: decoded.width,
      height: decoded.height
    },
    metadata: readJpegMetadata(bytes)
  };
}

function scaleTo8(value: number, depth: number): number {
  if (depth === 8) return value;
  if (depth === 16) return Math.floor((value * 255 + 32767) / 65535);
  return Math.floor((value * 255 * 2 + ((1 << depth) - 1)) / (2 * ((1 << depth) - 1)));
}

/** fast-png output (any depth, gray/gray+alpha/RGB/RGBA/indexed) -> RGBA8. */
function pngToRgba(png: DecodedPng): Uint8ClampedArray {
  const { width, height } = png;
  const pixelCount = width * height;
  const out = new Uint8ClampedArray(pixelCount * 4);
  if (png.palette) {
    const rgb = convertIndexedToRgb(png);
    const channels = rgb.length / pixelCount;
    for (let i = 0; i < pixelCount; i += 1) {
      out[i * 4] = rgb[i * channels]!;
      out[i * 4 + 1] = rgb[i * channels + 1]!;
      out[i * 4 + 2] = rgb[i * channels + 2]!;
      out[i * 4 + 3] = channels === 4 ? rgb[i * channels + 3]! : 255;
    }
    return out;
  }
  const { channels, depth, data } = png;
  // Sub-byte grayscale samples stay bit-packed per row; unpack them.
  const sample =
    depth < 8
      ? (() => {
          const rowBytes = Math.ceil((width * depth) / 8);
          const perByte = 8 / depth;
          const mask = (1 << depth) - 1;
          return (pixel: number) => {
            const row = Math.floor(pixel / width);
            const col = pixel - row * width;
            const byte = data[row * rowBytes + Math.floor(col / perByte)]!;
            const shift = 8 - depth * ((col % perByte) + 1);
            return (byte >> shift) & mask;
          };
        })()
      : null;
  const key = png.transparency;
  for (let i = 0; i < pixelCount; i += 1) {
    let r: number;
    let g: number;
    let b: number;
    let a: number;
    let transparentKey = false;
    if (channels <= 2) {
      const v = sample ? sample(i) : data[i * channels]!;
      r = g = b = scaleTo8(v, depth);
      a = channels === 2 ? scaleTo8(data[i * 2 + 1]!, depth) : 255;
      transparentKey = channels === 1 && !!key && key.length >= 1 && v === key[0];
    } else {
      const base = i * channels;
      const rv = data[base]!;
      const gv = data[base + 1]!;
      const bv = data[base + 2]!;
      r = scaleTo8(rv, depth);
      g = scaleTo8(gv, depth);
      b = scaleTo8(bv, depth);
      a = channels === 4 ? scaleTo8(data[base + 3]!, depth) : 255;
      transparentKey =
        channels === 3 && !!key && key.length >= 3 && rv === key[0] && gv === key[1] && bv === key[2];
    }
    out[i * 4] = r;
    out[i * 4 + 1] = g;
    out[i * 4 + 2] = b;
    out[i * 4 + 3] = transparentKey ? 0 : a;
  }
  return out;
}

function decodePng(bytes: Uint8Array): DecodedRaster {
  const png = decodePngBytes(bytes);
  return {
    format: "png",
    image: { data: pngToRgba(png), width: png.width, height: png.height },
    // Grayscale PNGs carry gray ICC profiles, which the matrix/TRC path
    // reports as unsupported (-> treated as sRGB with a note), as specified.
    // PNG eXIf orientation is not applied (rare; browsers disagree on it too).
    metadata: { iccProfile: png.iccEmbeddedProfile?.profile ?? null, orientation: 1 }
  };
}

type WebpDecode = (buffer: ArrayBuffer) => Promise<{ data: Uint8ClampedArray; width: number; height: number }>;
let webpDecoder: Promise<WebpDecode> | null = null;
let webpWasmModule: WebAssembly.Module | null = null;

/**
 * Lazily load the libwebp WASM decoder. In the browser webpack emits the
 * .wasm as an asset under the basePath and Emscripten fetches it; only loaded
 * when a WebP is actually uploaded.
 */
function loadWebpDecoder(): Promise<WebpDecode> {
  if (!webpDecoder) {
    webpDecoder = import("@jsquash/webp/decode.js").then(async (module) => {
      if (webpWasmModule) await module.init(webpWasmModule);
      return module.default as WebpDecode;
    });
  }
  return webpDecoder;
}

/**
 * Node only (tests, scripts/analyze-file.ts): Emscripten can't fetch the .wasm
 * from a file: URL there, so callers compile node_modules/@jsquash/webp/codec/
 * dec/webp_dec.wasm themselves and hand it over. Same decoder, same output.
 */
export function provideWebpWasmModule(module: WebAssembly.Module): void {
  webpWasmModule = module;
  webpDecoder = null;
}

async function decodeWebp(bytes: Uint8Array): Promise<DecodedRaster> {
  const decode = await loadWebpDecoder();
  const copy = bytes.slice().buffer;
  const decoded = await decode(copy);
  return {
    format: "webp",
    image: {
      data: new Uint8ClampedArray(decoded.data.buffer, decoded.data.byteOffset, decoded.data.byteLength),
      width: decoded.width,
      height: decoded.height
    },
    metadata: readWebpMetadata(bytes)
  };
}

/** Decode JPEG / PNG / WebP bytes to full-resolution RGBA. Never uses the DOM. */
export async function decodeRasterBytes(bytes: Uint8Array): Promise<DecodedRaster> {
  const format = detectRasterFormat(bytes);
  switch (format) {
    case "jpeg":
      return decodeJpeg(bytes);
    case "png":
      return decodePng(bytes);
    case "webp":
      return decodeWebp(bytes);
    default:
      throw new Error("Unsupported image format: expected JPEG, PNG or WebP bytes.");
  }
}

export type AnalysisMode = "survey" | "pixels-only";

export type ImageAnalysisResult = {
  format: RasterFormat;
  /** Analysis-size, upright, sRGB pixels — what sourcePixelsRef holds. */
  pixels: RgbaImage;
  /** Palette survey of `pixels` (null in pixels-only mode). */
  survey: PaletteSurvey | null;
  color: SrgbConversionResult;
  sourceWidth: number;
  sourceHeight: number;
  timingsMs: { decode: number; prepare: number; total: number };
};

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

/**
 * The production analysis pipeline: bytes -> our decode -> ICC -> sRGB ->
 * box downscale -> orientation -> palette survey. `pixels-only` skips the
 * survey (re-opening a saved project: the palette comes from the backend).
 */
export async function analyzeImageBytes(
  bytes: Uint8Array,
  mode: AnalysisMode = "survey"
): Promise<ImageAnalysisResult> {
  const start = now();
  const decoded = await decodeRasterBytes(bytes);
  const decodedAt = now();
  const prepared =
    mode === "survey"
      ? analyzeDecodedImage(decoded.image, decoded.metadata)
      : { ...prepareAnalysisImage(decoded.image, decoded.metadata), survey: null };
  const end = now();
  return {
    format: decoded.format,
    pixels: prepared.image,
    survey: prepared.survey,
    color: prepared.color,
    sourceWidth: prepared.sourceWidth,
    sourceHeight: prepared.sourceHeight,
    timingsMs: { decode: decodedAt - start, prepare: end - decodedAt, total: end - start }
  };
}
