// Determinism + correctness of the production analysis pipeline
// (imageAnalysis.ts -> @muralist/core) on synthetic images encoded in-test.
// Runs in Node: there is no document, canvas, ImageBitmap or <img> here, so
// passing at all proves analysis never touches a browser decode/readback.

import { readFileSync } from "node:fs";
import { crc32, deflateSync } from "node:zlib";
import test from "node:test";
import assert from "node:assert/strict";
import { encode as encodeJpeg } from "jpeg-js";
import { encode as encodePng } from "fast-png";
import { createSrgbConverter, parseIccProfile, type IccMatrixTrcProfile } from "@muralist/core";
import { analyzeImageBytes, detectRasterFormat, provideWebpWasmModule } from "./imageAnalysis";
import { runAutoCombine } from "./autoCombine";

// Authored Display P3 profile (packages/core/test/iccProfileBuilder.ts).
const P3_ICC = new Uint8Array(
  readFileSync(require.resolve("../../../packages/core/test/fixtures/display-p3-authored.icc"))
);

const COLORS = {
  navy: [46, 62, 82],
  teal: [70, 175, 177],
  yellow: [248, 213, 92],
  white: [250, 251, 251],
  pink: [230, 153, 162]
} as const;

/** 640x480 flat artwork (block edges on multiples of 16 so JPEG blocks stay pure). */
function artwork(): Uint8Array {
  const width = 640;
  const height = 480;
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let c: readonly number[] = COLORS.navy;
      if (x < 320 && y < 240) c = COLORS.teal;
      else if (x >= 400 && y >= 304) c = COLORS.yellow;
      if (y >= 448) c = COLORS.white;
      if (x >= 592 && x < 624 && y < 32) c = COLORS.pink;
      data.set([c[0]!, c[1]!, c[2]!, 255], (y * width + x) * 4);
    }
  }
  return data;
}

function withJpegIcc(jpeg: Uint8Array, icc: Uint8Array): Uint8Array {
  const payload = new Uint8Array([...Buffer.from("ICC_PROFILE\0", "latin1"), 1, 1, ...icc]);
  const length = payload.length + 2;
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe2, length >> 8, length & 0xff, ...payload, ...jpeg.subarray(2)]);
}

function withPngIcc(png: Uint8Array, icc: Uint8Array): Uint8Array {
  const body = new Uint8Array([...Buffer.from("iCCP", "latin1"), ...Buffer.from("P3\0", "latin1"), 0, ...deflateSync(icc)]);
  const chunk = new Uint8Array(body.length + 8);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, body.length - 4);
  chunk.set(body, 4);
  view.setUint32(body.length + 4, crc32(body));
  const ihdrEnd = 8 + 25;
  return new Uint8Array([...png.subarray(0, ihdrEnd), ...chunk, ...png.subarray(ihdrEnd)]);
}

const pixels = artwork();
const jpegPlain = new Uint8Array(encodeJpeg({ data: pixels, width: 640, height: 480 }, 95).data);
const jpegP3 = withJpegIcc(jpegPlain, P3_ICC);
const pngPlain = encodePng({ data: pixels, width: 640, height: 480, channels: 4, depth: 8 });
const pngP3 = withPngIcc(pngPlain, P3_ICC);
const p3 = createSrgbConverter(parseIccProfile(P3_ICC) as IccMatrixTrcProfile);
const hex = (rgb: readonly number[]) => `#${rgb.map((v) => v.toString(16).padStart(2, "0")).join("")}`.toUpperCase();

test("format detection by magic bytes", () => {
  assert.equal(detectRasterFormat(jpegP3), "jpeg");
  assert.equal(detectRasterFormat(pngP3), "png");
  assert.equal(detectRasterFormat(new Uint8Array([1, 2, 3])), null);
});

test("PNG + Display P3: exact expected palette, byte-identical across runs", async () => {
  const first = await analyzeImageBytes(pngP3);
  const second = await analyzeImageBytes(pngP3);
  assert.equal(first.color.status, "converted");
  assert.equal(first.color.profileDescription, "Display P3 (Muralist test profile)");
  assert.deepEqual([first.pixels.width, first.pixels.height], [320, 240]);
  assert.deepEqual(first.pixels.data, second.pixels.data);
  assert.deepEqual(first.survey, second.survey);
  // Lossless + block-aligned: every analysis pixel is a pure converted color.
  const expected = [COLORS.navy, COLORS.teal, COLORS.yellow, COLORS.white, COLORS.pink].map((c) =>
    hex(p3.convertPixel(c[0], c[1], c[2]))
  );
  assert.deepEqual(first.survey!.colors.map((c) => c.hex), expected);
  assert.deepEqual(expected, ["#293F54", "#00B2B3", "#FFD33D", "#FAFBFB", "#F395A1"]);
});

test("untagged PNG keeps the raw sRGB values", async () => {
  const result = await analyzeImageBytes(pngPlain);
  assert.equal(result.color.status, "untagged");
  assert.deepEqual(result.survey!.colors.map((c) => c.hex), ["#2E3E52", "#46AFB1", "#F8D55C", "#FAFBFB", "#E699A2"]);
});

test("JPEG + Display P3: deterministic palette and classification, converted colors", async () => {
  const runs = await Promise.all([analyzeImageBytes(jpegP3), analyzeImageBytes(jpegP3)]);
  const [first, second] = runs;
  assert.equal(first!.color.status, "converted");
  assert.deepEqual(first!.pixels.data, second!.pixels.data);
  assert.deepEqual(first!.survey, second!.survey);
  const top = first!.survey!.colors[0]!;
  const navy = p3.convertPixel(...COLORS.navy);
  top.rgb.forEach((v, i) => assert.ok(Math.abs(v - navy[i]!) <= 3, `navy ${top.rgb} vs ${navy}`));
  const teal = first!.survey!.colors.find((c) => c.rgb[0] < 30 && c.rgb[2] > 150);
  assert.ok(teal, "converted teal present (P3 teal is more saturated in sRGB)");

  for (const preset of [
    { residualThreshold: 0.04, mixCoveragePercent: 5 },
    { residualThreshold: 0.07, mixCoveragePercent: 0 }
  ]) {
    const a = runAutoCombine(first!.survey!.colors, preset);
    const b = runAutoCombine(second!.survey!.colors, preset);
    assert.deepEqual(a, b);
  }
});

test("WebP (libwebp WASM) decodes to the same pixels as the lossless PNG", async () => {
  provideWebpWasmModule(
    await WebAssembly.compile(readFileSync(require.resolve("@jsquash/webp/codec/dec/webp_dec.wasm")))
  );
  const encoder = await import("@jsquash/webp/encode.js");
  await encoder.init(
    await WebAssembly.compile(readFileSync(require.resolve("@jsquash/webp/codec/enc/webp_enc.wasm")))
  );
  const webp = new Uint8Array(
    await encoder.default(
      { data: new Uint8ClampedArray(pixels), width: 640, height: 480, colorSpace: "srgb" } as ImageData,
      { lossless: 1, exact: 1 }
    )
  );
  const fromWebp = await analyzeImageBytes(webp);
  const fromPng = await analyzeImageBytes(pngPlain);
  assert.equal(fromWebp.format, "webp");
  assert.deepEqual(fromWebp.survey, fromPng.survey);
});

test("analysis modules are DOM-free (no canvas / ImageBitmap / <img> in the key path)", () => {
  assert.equal(typeof (globalThis as { document?: unknown }).document, "undefined");
  for (const file of ["./imageAnalysis.ts", "./analysisWorker.ts"]) {
    const source = readFileSync(require.resolve(file), "utf8")
      .split("\n")
      .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
      .join("\n");
    for (const forbidden of ["getImageData", "getContext", "createImageBitmap", "OffscreenCanvas", "new Image(", "document."]) {
      assert.ok(!source.includes(forbidden), `${file} must not use ${forbidden}`);
    }
  }
});
