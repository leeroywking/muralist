import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import {
  ANALYSIS_MAX_DIMENSION,
  analyzeDecodedImage,
  applyExifOrientation,
  classifyPaletteColors,
  convertRgbaToSrgb,
  createSrgbConverter,
  downscaleBoxRgba,
  encodeLinearToSrgb8,
  flattenPixelsToPalette,
  getAnalysisDimensions,
  invertMat3,
  multiplyMat3Vec3,
  parseIccProfile,
  readExifOrientation,
  readJpegMetadata,
  readWebpMetadata,
  srgbDecode,
  srgbEncode,
  surveyPalette,
  SRGB_TO_XYZ_D50,
  type IccMatrixTrcProfile,
  type Mat3,
  type RgbaImage,
  type Vec3
} from "../src/index.js";
import { buildIccProfile, DISPLAY_P3_SPEC, SRGB_PARA } from "./iccProfileBuilder.js";

const P3_ICC = new Uint8Array(readFileSync(new URL("./fixtures/display-p3-authored.icc", import.meta.url)));

function matrixProfile(bytes: Uint8Array): IccMatrixTrcProfile {
  const parsed = parseIccProfile(bytes);
  assert.equal(parsed.kind, "matrix-trc");
  return parsed as IccMatrixTrcProfile;
}

// Independent reference: Display P3 -> sRGB entirely in D65 (no PCS, no
// Bradford), from the published primaries. Our PCS route must agree to ±1.
function primariesToXyz(prims: [number, number][], white: [number, number]): Mat3 {
  const X = (x: number, y: number): Vec3 => [x / y, 1, (1 - x - y) / y];
  const p = prims.map(([x, y]) => X(x, y));
  const P: Mat3 = [
    [p[0]![0], p[1]![0], p[2]![0]],
    [p[0]![1], p[1]![1], p[2]![1]],
    [p[0]![2], p[1]![2], p[2]![2]]
  ];
  const S = multiplyMat3Vec3(invertMat3(P), X(white[0], white[1]));
  return P.map((row) => row.map((v, i) => v * S[i]!)) as Mat3;
}
const D65_XY: [number, number] = [0.3127, 0.329];
const P3_TO_XYZ = primariesToXyz([[0.68, 0.32], [0.265, 0.69], [0.15, 0.06]], D65_XY);
const XYZ_TO_SRGB = invertMat3(primariesToXyz([[0.64, 0.33], [0.3, 0.6], [0.15, 0.06]], D65_XY));
function referenceP3ToSrgb(rgb: Vec3): Vec3 {
  const linear = rgb.map((v) => srgbDecode(v / 255)) as Vec3;
  const out = multiplyMat3Vec3(XYZ_TO_SRGB, multiplyMat3Vec3(P3_TO_XYZ, linear));
  return out.map((v) => Math.round(Math.min(1, Math.max(0, srgbEncode(Math.min(1, Math.max(0, v))))) * 255)) as Vec3;
}

test("ICC: parses the authored Display P3 profile as matrix/TRC", () => {
  const profile = matrixProfile(P3_ICC);
  assert.equal(profile.description, "Display P3 (Muralist test profile)");
  assert.equal(profile.trc[0].type, "parametric");
  assert.ok(Math.abs(profile.rXYZ[0] - 0.515092) < 1e-4);
});

test("ICC: Display P3 primaries, white and grey convert to the expected sRGB", () => {
  const converter = createSrgbConverter(matrixProfile(P3_ICC));
  assert.equal(converter.identity, false);
  // P3 red/green/blue are outside sRGB: relative colorimetric + clip.
  assert.deepEqual(converter.convertPixel(255, 0, 0), [255, 0, 0]);
  assert.deepEqual(converter.convertPixel(0, 255, 0), [0, 255, 0]);
  assert.deepEqual(converter.convertPixel(0, 0, 255), [0, 0, 255]);
  // White stays white, black stays black, greys stay neutral.
  assert.deepEqual(converter.convertPixel(255, 255, 255), [255, 255, 255]);
  assert.deepEqual(converter.convertPixel(0, 0, 0), [0, 0, 0]);
  for (const v of [32, 64, 128, 192, 240]) {
    assert.deepEqual(converter.convertPixel(v, v, v), [v, v, v], `grey ${v}`);
  }
  // Desaturated P3 color that is inside sRGB: matches the D65 reference ±1.
  for (const rgb of [[200, 100, 50], [70, 175, 177], [248, 213, 92], [120, 140, 200], [230, 180, 190]] as Vec3[]) {
    const ours = converter.convertPixel(...rgb);
    const ref = referenceP3ToSrgb(rgb);
    ours.forEach((v, i) => assert.ok(Math.abs(v - ref[i]!) <= 1, `${rgb} -> ${ours} vs ${ref}`));
  }
  // A P3 teal is more saturated once expressed in sRGB.
  const teal = converter.convertPixel(70, 175, 177);
  assert.ok(teal[0] < 70 && teal[2] > 177, `teal ${teal}`);
});

test("ICC: conversion is deterministic and every in-gamut sRGB value round-trips", () => {
  const converter = createSrgbConverter(matrixProfile(P3_ICC));
  const first: number[] = [];
  const second: number[] = [];
  for (let r = 0; r < 256; r += 17) {
    for (let g = 0; g < 256; g += 17) {
      for (let b = 0; b < 256; b += 17) {
        first.push(...converter.convertPixel(r, g, b));
        second.push(...createSrgbConverter(matrixProfile(P3_ICC)).convertPixel(r, g, b));
      }
    }
  }
  assert.deepEqual(first, second);
  for (let v = 0; v < 256; v += 1) {
    assert.equal(encodeLinearToSrgb8(srgbDecode(v / 255)), v);
  }
  assert.equal(encodeLinearToSrgb8(-0.2), 0);
  assert.equal(encodeLinearToSrgb8(1.3), 255);
  assert.equal(encodeLinearToSrgb8(Number.NaN), 0);
});

test("ICC: an sRGB profile is detected as identity and leaves pixels untouched", () => {
  const cols = [0, 1, 2].map((c) => [SRGB_TO_XYZ_D50[0][c], SRGB_TO_XYZ_D50[1][c], SRGB_TO_XYZ_D50[2][c]] as Vec3);
  const srgb = buildIccProfile({ description: "sRGB test", rXYZ: cols[0], gXYZ: cols[1], bXYZ: cols[2], trc: SRGB_PARA });
  const converter = createSrgbConverter(matrixProfile(srgb));
  assert.equal(converter.identity, true);
  const data = new Uint8ClampedArray([12, 200, 99, 255, 250, 3, 77, 128]);
  const before = Array.from(data);
  assert.equal(convertRgbaToSrgb(data, srgb).status, "srgb");
  assert.deepEqual(Array.from(data), before);
  assert.equal(convertRgbaToSrgb(data, null).status, "untagged");
  assert.deepEqual(Array.from(data), before);
});

test("ICC: gamma (curv) and table curves, Adobe RGB-like profile", () => {
  // Adobe RGB (1998) D50-adapted colorants, gamma 563/256.
  const adobe = buildIccProfile({
    description: "Adobe-like",
    rXYZ: [0.60974, 0.31111, 0.01947],
    gXYZ: [0.20528, 0.62567, 0.06087],
    bXYZ: [0.14919, 0.06322, 0.74457],
    trc: { type: "gamma", gamma: 563 / 256 }
  });
  const converter = createSrgbConverter(matrixProfile(adobe));
  assert.deepEqual(converter.convertPixel(255, 255, 255), [255, 255, 255]);
  const grey = converter.convertPixel(128, 128, 128);
  assert.ok(grey[0] === grey[1] && grey[1] === grey[2], `grey ${grey}`);
  // Adobe green is far outside sRGB.
  assert.deepEqual(converter.convertPixel(0, 255, 0), [0, 255, 0]);
  // Table curve equal to the sRGB curve behaves like the parametric one.
  const table = Array.from({ length: 1024 }, (_, i) => srgbDecode(i / 1023));
  const p3Table = buildIccProfile({ ...DISPLAY_P3_SPEC, trc: { type: "table", table } });
  const viaTable = createSrgbConverter(matrixProfile(p3Table));
  const viaPara = createSrgbConverter(matrixProfile(P3_ICC));
  for (const rgb of [[200, 100, 50], [10, 20, 30], [128, 128, 128]] as Vec3[]) {
    viaTable.convertPixel(...rgb).forEach((v, i) => assert.ok(Math.abs(v - viaPara.convertPixel(...rgb)[i]!) <= 1));
  }
});

test("ICC: unadapted v2 colorants (summing to D65) are Bradford-adapted so white stays white", () => {
  const cols = [0, 1, 2].map((c) => [P3_TO_XYZ[0][c], P3_TO_XYZ[1][c], P3_TO_XYZ[2][c]] as Vec3);
  const legacy = buildIccProfile({
    description: "legacy v2",
    version: 2,
    wtpt: [0.95047, 1, 1.08883],
    rXYZ: cols[0],
    gXYZ: cols[1],
    bXYZ: cols[2],
    trc: SRGB_PARA
  });
  const converter = createSrgbConverter(matrixProfile(legacy));
  assert.deepEqual(converter.convertPixel(255, 255, 255), [255, 255, 255]);
  const modern = createSrgbConverter(matrixProfile(P3_ICC));
  for (const rgb of [[200, 100, 50], [70, 175, 177]] as Vec3[]) {
    converter.convertPixel(...rgb).forEach((v, i) => assert.ok(Math.abs(v - modern.convertPixel(...rgb)[i]!) <= 1));
  }
});

test("ICC: CMYK, gray and LUT-only profiles are unsupported -> pixels untouched + note", () => {
  const cmyk = buildIccProfile({ description: "CMYK", colorSpace: "CMYK" });
  const gray = buildIccProfile({ description: "Gray", colorSpace: "GRAY" });
  const lut = buildIccProfile({ description: "LUT RGB" });
  for (const bytes of [cmyk, gray, lut]) {
    assert.equal(parseIccProfile(bytes).kind, "unsupported");
    const data = new Uint8ClampedArray([10, 20, 30, 255]);
    const result = convertRgbaToSrgb(data, bytes);
    assert.equal(result.status, "unsupported");
    assert.ok(result.note && result.note.length > 0);
    assert.deepEqual(Array.from(data), [10, 20, 30, 255]);
  }
  assert.equal(parseIccProfile(new Uint8Array(10)).kind, "unsupported");
});

function exifWithOrientation(orientation: number): Uint8Array {
  // "MM" big-endian TIFF, IFD0 at 8 with one entry: 0x0112 SHORT 1 = orientation.
  return new Uint8Array([
    0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08,
    0x00, 0x01,
    0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, orientation, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00
  ]);
}

function segment(marker: number, payload: number[] | Uint8Array): number[] {
  const length = payload.length + 2;
  return [0xff, marker, length >> 8, length & 0xff, ...payload];
}

test("JPEG metadata: reassembles multi-chunk ICC_PROFILE and reads EXIF orientation", () => {
  const icc = P3_ICC;
  const half = 300;
  const header = (seq: number) => [...Array.from("ICC_PROFILE\0", (c) => c.charCodeAt(0)), seq, 2];
  const bytes = new Uint8Array([
    0xff, 0xd8,
    ...segment(0xe1, [...Array.from("Exif\0\0", (c) => c.charCodeAt(0)), ...exifWithOrientation(6)]),
    // chunks deliberately out of order
    ...segment(0xe2, [...header(2), ...icc.subarray(half)]),
    ...segment(0xe2, [...header(1), ...icc.subarray(0, half)]),
    0xff, 0xda, 0x00, 0x02, 0x11, 0x22, 0xff, 0xd9
  ]);
  const meta = readJpegMetadata(bytes);
  assert.equal(meta.orientation, 6);
  assert.deepEqual(meta.iccProfile, icc);
  assert.deepEqual(readJpegMetadata(new Uint8Array([0xff, 0xd8, 0xff, 0xd9])), { iccProfile: null, orientation: 1 });
  assert.equal(readExifOrientation(new Uint8Array([1, 2, 3])), 1);
});

test("WebP metadata: reads ICCP and EXIF chunks", () => {
  const chunk = (fourcc: string, payload: Uint8Array) => {
    const size = payload.length;
    const pad = size & 1 ? [0] : [];
    return [...Array.from(fourcc, (c) => c.charCodeAt(0)), size & 0xff, (size >> 8) & 0xff, (size >> 16) & 0xff, size >>> 24, ...payload, ...pad];
  };
  const body = [
    ...Array.from("WEBP", (c) => c.charCodeAt(0)),
    ...chunk("VP8X", new Uint8Array(10)),
    ...chunk("ICCP", P3_ICC),
    ...chunk("EXIF", exifWithOrientation(3))
  ];
  const bytes = new Uint8Array([...Array.from("RIFF", (c) => c.charCodeAt(0)), 0, 0, 0, 0, ...body]);
  const meta = readWebpMetadata(bytes);
  assert.deepEqual(meta.iccProfile, P3_ICC);
  assert.equal(meta.orientation, 3);
});

function solidImage(width: number, height: number, paint: (x: number, y: number) => [number, number, number, number]): RgbaImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      data.set(paint(x, y), (y * width + x) * 4);
    }
  }
  return { data, width, height };
}

test("downscale: exact integer box average, fractional coverage, alpha weighting", () => {
  // 2x2 -> 1x1 is the plain mean, rounded half up.
  const quad = solidImage(2, 2, (x, y) => [x * 100 + y, 0, 255, 255]);
  assert.deepEqual(Array.from(downscaleBoxRgba(quad, 1, 1).data), [51, 0, 255, 255]); // (0+1+100+101)/4 = 50.5 -> 51
  // 3x1 -> 2x1: target 0 covers px0 fully + half of px1; target 1 the rest.
  const row = solidImage(3, 1, (x) => [[0, 90, 180][x]!, 0, 0, 255]);
  assert.deepEqual(Array.from(downscaleBoxRgba(row, 2, 1).data), [30, 0, 0, 255, 150, 0, 0, 255]);
  // A fully transparent pixel doesn't darken its neighbor; alpha averages.
  const edge = solidImage(2, 1, (x) => (x === 0 ? [200, 100, 50, 255] : [0, 0, 0, 0]));
  assert.deepEqual(Array.from(downscaleBoxRgba(edge, 1, 1).data), [200, 100, 50, 128]);
  // Same size is a copy; upscaling is rejected.
  assert.deepEqual(Array.from(downscaleBoxRgba(quad, 2, 2).data), Array.from(quad.data));
  assert.throws(() => downscaleBoxRgba(quad, 3, 2));
});

test("downscale: deterministic on a noisy image and dimension semantics match the canvas era", () => {
  let seed = 7;
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) % 256;
  const noisy = solidImage(1003, 701, () => [rand(), rand(), rand(), 255]);
  const target = getAnalysisDimensions(1003, 701);
  assert.deepEqual(target, { width: 320, height: 224 });
  const a = downscaleBoxRgba(noisy, target.width, target.height);
  const b = downscaleBoxRgba(noisy, target.width, target.height);
  assert.deepEqual(a.data, b.data);
  assert.deepEqual(getAnalysisDimensions(200, 100), { width: 200, height: 100 });
  assert.deepEqual(getAnalysisDimensions(3000, 3000), { width: ANALYSIS_MAX_DIMENSION, height: ANALYSIS_MAX_DIMENSION });
});

test("orientation: all 8 EXIF orientations, and box downscale commutes with them", () => {
  // 3x2 stored image, pixel value = index.
  const stored = solidImage(3, 2, (x, y) => [y * 3 + x, 0, 0, 255]);
  const reds = (img: RgbaImage) => Array.from({ length: img.width * img.height }, (_, i) => img.data[i * 4]!);
  const expected: Record<number, { w: number; values: number[] }> = {
    1: { w: 3, values: [0, 1, 2, 3, 4, 5] },
    2: { w: 3, values: [2, 1, 0, 5, 4, 3] },
    3: { w: 3, values: [5, 4, 3, 2, 1, 0] },
    4: { w: 3, values: [3, 4, 5, 0, 1, 2] },
    5: { w: 2, values: [0, 3, 1, 4, 2, 5] },
    6: { w: 2, values: [3, 0, 4, 1, 5, 2] },
    7: { w: 2, values: [5, 2, 4, 1, 3, 0] },
    8: { w: 2, values: [2, 5, 1, 4, 0, 3] }
  };
  for (const [orientation, { w, values }] of Object.entries(expected)) {
    const upright = applyExifOrientation(stored, Number(orientation));
    assert.equal(upright.width, w, `orientation ${orientation}`);
    assert.deepEqual(reds(upright), values, `orientation ${orientation}`);
  }
  let seed = 3;
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) % 256;
  const noisy = solidImage(97, 61, () => [rand(), rand(), rand(), 255]);
  for (let orientation = 1; orientation <= 8; orientation += 1) {
    const swap = orientation >= 5;
    const viaUpright = applyExifOrientation(noisy, orientation);
    const a = downscaleBoxRgba(viaUpright, swap ? 23 : 41, swap ? 41 : 23);
    const b = applyExifOrientation(downscaleBoxRgba(noisy, 41, 23), orientation);
    assert.deepEqual(a.data, b.data, `orientation ${orientation}`);
  }
});

// Flat-art test image in Display P3: navy field, teal and yellow blocks, a
// white stripe and a small pink accent; block edges are aligned to the 2x
// downscale so every analysis pixel is a pure color.
const P3_COLORS: Record<string, [number, number, number]> = {
  navy: [46, 62, 82],
  teal: [70, 175, 177],
  yellow: [248, 213, 92],
  white: [250, 251, 251],
  pink: [230, 153, 162]
};
function p3Artwork(): RgbaImage {
  return solidImage(640, 480, (x, y) => {
    let c = P3_COLORS.navy!;
    if (x < 320 && y < 240) c = P3_COLORS.teal!;
    else if (x >= 400 && y >= 300) c = P3_COLORS.yellow!;
    if (y >= 440) c = P3_COLORS.white!;
    if (x >= 600 && x < 620 && y < 20) c = P3_COLORS.pink!;
    return [c[0], c[1], c[2], 255];
  });
}

test("pipeline: P3-tagged artwork -> ICC -> downscale -> orientation -> survey -> classify is byte-identical and correct", () => {
  const run = () => analyzeDecodedImage(p3Artwork(), { iccProfile: P3_ICC, orientation: 6 });
  const first = run();
  const second = run();
  assert.equal(first.color.status, "converted");
  assert.equal(first.sourceWidth, 480); // orientation 6 swaps axes
  assert.deepEqual([first.image.width, first.image.height], [240, 320]);
  assert.deepEqual(first.image.data, second.image.data);
  assert.deepEqual(first.survey, second.survey);

  const converter = createSrgbConverter(matrixProfile(P3_ICC));
  const toHex = (rgb: number[]) => `#${rgb.map((v) => v.toString(16).padStart(2, "0")).join("")}`.toUpperCase();
  const expectedHex = Object.fromEntries(
    Object.entries(P3_COLORS).map(([name, rgb]) => [name, toHex(converter.convertPixel(...rgb))])
  );
  // Regression pin of the converted values (P3 -> sRGB).
  assert.deepEqual(expectedHex, {
    navy: "#293F54",
    teal: "#00B2B3",
    yellow: "#FFD33D",
    white: "#FAFBFB",
    pink: "#F395A1"
  });
  const hexes = first.survey.colors.map((color) => color.hex);
  assert.deepEqual(hexes, [expectedHex.navy, expectedHex.teal, expectedHex.yellow, expectedHex.white, expectedHex.pink]);
  assert.equal(first.survey.colors.reduce((sum, c) => sum + c.pixelCount, 0) > 0, true);

  const classify = (survey: typeof first.survey) =>
    classifyPaletteColors(
      survey.colors.map((c) => ({ id: c.id, rgb: c.rgb, pixelCount: c.pixelCount })),
      { residualThreshold: 0.04, mixCoveragePercent: 5 }
    );
  assert.deepEqual(classify(first.survey), classify(second.survey));
});

test("pipeline: untagged and sRGB-tagged copies of an image survey identically", () => {
  const cols = [0, 1, 2].map((c) => [SRGB_TO_XYZ_D50[0][c], SRGB_TO_XYZ_D50[1][c], SRGB_TO_XYZ_D50[2][c]] as Vec3);
  const srgb = buildIccProfile({ description: "sRGB test", rXYZ: cols[0], gXYZ: cols[1], bXYZ: cols[2], trc: SRGB_PARA });
  const untagged = analyzeDecodedImage(p3Artwork(), { iccProfile: null, orientation: 1 });
  const tagged = analyzeDecodedImage(p3Artwork(), { iccProfile: srgb, orientation: 1 });
  assert.deepEqual(untagged.survey, tagged.survey);
  assert.deepEqual(untagged.survey.colors[0]!.rgb, P3_COLORS.navy);
});

test("survey + flatten: deterministic, transparent pixels skipped, bare-wall colors cut out", () => {
  const image = solidImage(4, 1, (x) => [[[255, 0, 0, 255], [250, 5, 5, 255], [0, 0, 255, 255], [0, 255, 0, 0]] as const][0][x]!.slice() as [number, number, number, number]);
  const survey = surveyPalette(image);
  assert.deepEqual(surveyPalette(image), survey);
  assert.equal(survey.colors.length, 2);
  assert.equal(survey.colors[0]!.pixelCount, 2);
  const flat = flattenPixelsToPalette(image, survey.colors, new Set([survey.colors[1]!.id]));
  assert.ok(flat);
  assert.deepEqual(Array.from(flat!.subarray(0, 4)), [...survey.colors[0]!.rgb, 255]);
  assert.equal(flat![11], 0); // blue -> bare wall
  assert.equal(flat![15], 0); // transparent source
  assert.equal(flattenPixelsToPalette(image, []), null);
  assert.throws(() => surveyPalette(solidImage(2, 2, () => [0, 0, 0, 0])));
});
