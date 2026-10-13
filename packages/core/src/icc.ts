// ICC color management for the analysis pipeline: embedded profile -> sRGB.
//
// PRODUCT RULE (user, 2026-10-12): "I don't want the browser-modified file in
// our key path at all. If what is rendered to the user contains privacy noise
// that's fine, as long as we aren't running calculations against it." Every
// calculation (palette survey, coverage, classification input, reduced-preview
// flattening) runs on pixels we decode ourselves from the file's bytes. Browsers
// color-manage tagged images differently (Display P3 Procreate exports came out
// as three different palettes in three browsers), so we do the ICC -> sRGB step
// here, in pure, deterministic code.
//
// Supported: matrix/TRC RGB profiles (rXYZ/gXYZ/bXYZ colorants + rTRC/gTRC/bTRC
// `curv` or `para` curves) — Display P3, Adobe RGB, ProPhoto, sRGB and the
// like. Rendering intent is relative colorimetric with hard clipping to the
// sRGB gamut. Anything else (LUT-based A2B profiles without colorants, CMYK,
// gray, Lab PCS) is reported as unsupported and the caller treats the pixels as
// sRGB and surfaces a note.
//
// Determinism: the hot loop is table lookups, a 3x3 multiply (IEEE + and * are
// bit-identical across JS engines) and threshold comparisons. Math.pow only
// builds the 256-entry decode tables and the 255 sRGB encode thresholds; an
// engine ulp difference there could only matter if a pixel landed within one
// ulp of an 8-bit rounding boundary.

export type Vec3 = [number, number, number];
export type Mat3 = [Vec3, Vec3, Vec3];

export type IccToneCurve =
  | { type: "identity" }
  | { type: "gamma"; gamma: number }
  | { type: "table"; table: number[] } // values 0..1
  | { type: "parametric"; functionType: number; params: number[] };

export type IccMatrixTrcProfile = {
  kind: "matrix-trc";
  version: number;
  description: string | null;
  /** Colorant columns in the PCS (D50) as stored in the profile. */
  rXYZ: Vec3;
  gXYZ: Vec3;
  bXYZ: Vec3;
  whitePoint: Vec3 | null;
  trc: [IccToneCurve, IccToneCurve, IccToneCurve];
};

export type IccUnsupportedProfile = {
  kind: "unsupported";
  colorSpace: string;
  reason: string;
  description: string | null;
};

export type IccProfile = IccMatrixTrcProfile | IccUnsupportedProfile;

/** ICC PCS illuminant (D50), exactly as the ICC spec defines it. */
export const D50_WHITE: Vec3 = [0.9642, 1.0, 0.8249];
export const D65_WHITE: Vec3 = [0.95047, 1.0, 1.08883];

const BRADFORD: Mat3 = [
  [0.8951, 0.2664, -0.1614],
  [-0.7502, 1.7135, 0.0367],
  [0.0389, -0.0685, 1.0296]
];

/** Linear sRGB -> XYZ (D65), IEC 61966-2-1. */
const SRGB_TO_XYZ_D65: Mat3 = [
  [0.4124564, 0.3575761, 0.1804375],
  [0.2126729, 0.7151522, 0.072175],
  [0.0193339, 0.119192, 0.9503041]
];

function readTag(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(bytes[offset]!, bytes[offset + 1]!, bytes[offset + 2]!, bytes[offset + 3]!);
}

function u32(view: DataView, offset: number): number {
  return view.getUint32(offset, false);
}

function s15Fixed16(view: DataView, offset: number): number {
  return view.getInt32(offset, false) / 65536;
}

function readXyz(bytes: Uint8Array, view: DataView, offset: number, size: number): Vec3 | null {
  if (size < 20 || offset + 20 > bytes.length) return null;
  if (readTag(bytes, offset) !== "XYZ ") return null;
  return [s15Fixed16(view, offset + 8), s15Fixed16(view, offset + 12), s15Fixed16(view, offset + 16)];
}

function readCurve(bytes: Uint8Array, view: DataView, offset: number, size: number): IccToneCurve | null {
  if (size < 12 || offset + 12 > bytes.length) return null;
  const type = readTag(bytes, offset);
  if (type === "curv") {
    const count = u32(view, offset + 8);
    if (count === 0) return { type: "identity" };
    if (count === 1) {
      if (offset + 14 > bytes.length) return null;
      return { type: "gamma", gamma: view.getUint16(offset + 12, false) / 256 };
    }
    if (offset + 12 + count * 2 > bytes.length) return null;
    const table: number[] = [];
    for (let i = 0; i < count; i += 1) {
      table.push(view.getUint16(offset + 12 + i * 2, false) / 65535);
    }
    return { type: "table", table };
  }
  if (type === "para") {
    const functionType = view.getUint16(offset + 8, false);
    const paramCount = [1, 3, 4, 5, 7][functionType];
    if (paramCount === undefined || offset + 12 + paramCount * 4 > bytes.length) return null;
    const params: number[] = [];
    for (let i = 0; i < paramCount; i += 1) {
      params.push(s15Fixed16(view, offset + 12 + i * 4));
    }
    return { type: "parametric", functionType, params };
  }
  return null;
}

function readDescription(bytes: Uint8Array, view: DataView, offset: number, size: number): string | null {
  if (size < 12 || offset + 12 > bytes.length) return null;
  const type = readTag(bytes, offset);
  if (type === "desc") {
    const length = u32(view, offset + 8);
    const end = Math.min(bytes.length, offset + 12 + length);
    let text = "";
    for (let i = offset + 12; i < end && bytes[i] !== 0; i += 1) text += String.fromCharCode(bytes[i]!);
    return text;
  }
  if (type === "mluc") {
    const records = u32(view, offset + 8);
    if (records < 1 || offset + 28 > bytes.length) return null;
    const length = u32(view, offset + 20);
    const start = offset + u32(view, offset + 24);
    let text = "";
    for (let i = 0; i + 1 < length && start + i + 1 < bytes.length; i += 2) {
      text += String.fromCharCode(view.getUint16(start + i, false));
    }
    return text;
  }
  return null;
}

/**
 * Parse an ICC profile far enough to build a matrix/TRC transform. Never
 * throws: malformed or unsupported profiles come back as `kind: "unsupported"`.
 */
export function parseIccProfile(bytes: Uint8Array): IccProfile {
  if (bytes.length < 132) {
    return { kind: "unsupported", colorSpace: "????", reason: "truncated profile", description: null };
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = bytes[8]!;
  const colorSpace = readTag(bytes, 16);
  const pcs = readTag(bytes, 20);
  const tagCount = u32(view, 128);
  const tags = new Map<string, { offset: number; size: number }>();
  for (let i = 0; i < tagCount; i += 1) {
    const entry = 132 + i * 12;
    if (entry + 12 > bytes.length) break;
    tags.set(readTag(bytes, entry), { offset: u32(view, entry + 4), size: u32(view, entry + 8) });
  }
  const descTag = tags.get("desc");
  const description = descTag ? readDescription(bytes, view, descTag.offset, descTag.size) : null;

  if (colorSpace !== "RGB ") {
    return { kind: "unsupported", colorSpace, reason: `${colorSpace.trim() || "unknown"} profile`, description };
  }
  if (pcs !== "XYZ ") {
    return { kind: "unsupported", colorSpace, reason: "Lab-PCS (LUT-based) profile", description };
  }
  const xyz = (sig: string) => {
    const tag = tags.get(sig);
    return tag ? readXyz(bytes, view, tag.offset, tag.size) : null;
  };
  const curve = (sig: string) => {
    const tag = tags.get(sig);
    return tag ? readCurve(bytes, view, tag.offset, tag.size) : null;
  };
  const rXYZ = xyz("rXYZ");
  const gXYZ = xyz("gXYZ");
  const bXYZ = xyz("bXYZ");
  const rTRC = curve("rTRC");
  const gTRC = curve("gTRC");
  const bTRC = curve("bTRC");
  if (!rXYZ || !gXYZ || !bXYZ || !rTRC || !gTRC || !bTRC) {
    return { kind: "unsupported", colorSpace, reason: "LUT-based RGB profile", description };
  }
  return {
    kind: "matrix-trc",
    version,
    description,
    rXYZ,
    gXYZ,
    bXYZ,
    whitePoint: xyz("wtpt"),
    trc: [rTRC, gTRC, bTRC]
  };
}

/** Evaluate an ICC tone curve (device value 0..1 -> linear 0..1). */
export function evaluateToneCurve(curve: IccToneCurve, x: number): number {
  switch (curve.type) {
    case "identity":
      return x;
    case "gamma":
      return Math.pow(x, curve.gamma);
    case "table": {
      const table = curve.table;
      const position = x * (table.length - 1);
      const index = Math.min(table.length - 2, Math.floor(position));
      const fraction = position - index;
      return table[index]! + (table[index + 1]! - table[index]!) * fraction;
    }
    case "parametric": {
      const [g = 1, a = 1, b = 0, c = 0, d = 0, e = 0, f = 0] = curve.params;
      const power = (base: number) => (base > 0 ? Math.pow(base, g) : 0);
      switch (curve.functionType) {
        case 0:
          return power(x);
        case 1:
          return x >= -b / a ? power(a * x + b) : 0;
        case 2:
          return x >= -b / a ? power(a * x + b) + c : c;
        case 3:
          return x >= d ? power(a * x + b) : c * x;
        case 4:
          return x >= d ? power(a * x + b) + e : c * x + f;
        default:
          return x;
      }
    }
  }
}

export function multiplyMat3(left: Mat3, right: Mat3): Mat3 {
  const out: Mat3 = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0]
  ];
  for (let row = 0; row < 3; row += 1) {
    for (let col = 0; col < 3; col += 1) {
      out[row]![col] =
        left[row]![0]! * right[0]![col]! + left[row]![1]! * right[1]![col]! + left[row]![2]! * right[2]![col]!;
    }
  }
  return out;
}

export function multiplyMat3Vec3(matrix: Mat3, vector: Vec3): Vec3 {
  return [
    matrix[0][0] * vector[0] + matrix[0][1] * vector[1] + matrix[0][2] * vector[2],
    matrix[1][0] * vector[0] + matrix[1][1] * vector[1] + matrix[1][2] * vector[2],
    matrix[2][0] * vector[0] + matrix[2][1] * vector[1] + matrix[2][2] * vector[2]
  ];
}

export function invertMat3(m: Mat3): Mat3 {
  const [[a, b, c], [d, e, f], [g, h, i]] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (det === 0) throw new Error("Singular matrix.");
  return [
    [A / det, -(b * i - c * h) / det, (b * f - c * e) / det],
    [B / det, (a * i - c * g) / det, -(a * f - c * d) / det],
    [C / det, -(a * h - b * g) / det, (a * e - b * d) / det]
  ];
}

/** Bradford chromatic adaptation matrix from one white point to another. */
export function bradfordAdaptation(from: Vec3, to: Vec3): Mat3 {
  const coneFrom = multiplyMat3Vec3(BRADFORD, from);
  const coneTo = multiplyMat3Vec3(BRADFORD, to);
  const scale: Mat3 = [
    [coneTo[0] / coneFrom[0], 0, 0],
    [0, coneTo[1] / coneFrom[1], 0],
    [0, 0, coneTo[2] / coneFrom[2]]
  ];
  return multiplyMat3(invertMat3(BRADFORD), multiplyMat3(scale, BRADFORD));
}

/** Linear sRGB -> XYZ in the D50 PCS (Bradford-adapted, as sRGB ICC profiles store it). */
export const SRGB_TO_XYZ_D50: Mat3 = multiplyMat3(bradfordAdaptation(D65_WHITE, D50_WHITE), SRGB_TO_XYZ_D65);
const XYZ_D50_TO_SRGB: Mat3 = invertMat3(SRGB_TO_XYZ_D50);

export function srgbEncode(linear: number): number {
  return linear <= 0.0031308 ? linear * 12.92 : 1.055 * Math.pow(linear, 1 / 2.4) - 0.055;
}

export function srgbDecode(encoded: number): number {
  return encoded <= 0.04045 ? encoded / 12.92 : Math.pow((encoded + 0.055) / 1.055, 2.4);
}

// SRGB_THRESHOLDS[v] = the smallest linear value that encodes to 8-bit v
// (v = 1..255); everything below SRGB_THRESHOLDS[1] encodes to 0.
const SRGB_THRESHOLDS = new Float64Array(256);
for (let v = 1; v < 256; v += 1) SRGB_THRESHOLDS[v] = srgbDecode((v - 0.5) / 255);
// Coarse index over linear [0,1] so encoding is a lookup + at most a few
// exact threshold comparisons (bit-identical to a full binary search).
const ENCODE_INDEX_SIZE = 4096;
const ENCODE_INDEX = new Uint8Array(ENCODE_INDEX_SIZE + 1);
{
  let v = 0;
  for (let k = 0; k <= ENCODE_INDEX_SIZE; k += 1) {
    const linear = k / ENCODE_INDEX_SIZE;
    while (v < 255 && linear >= SRGB_THRESHOLDS[v + 1]!) v += 1;
    ENCODE_INDEX[k] = v;
  }
}

/** Linear-light value -> 8-bit sRGB, clipped to [0, 255]. Exact and deterministic. */
export function encodeLinearToSrgb8(linear: number): number {
  if (!(linear > 0)) return 0; // also catches NaN
  if (linear >= 1) return 255;
  let v = ENCODE_INDEX[Math.floor(linear * ENCODE_INDEX_SIZE)]!;
  while (v < 255 && linear >= SRGB_THRESHOLDS[v + 1]!) v += 1;
  return v;
}

export type SrgbConverter = {
  /** True when the profile is sRGB in all but name: pixels pass through untouched. */
  identity: boolean;
  /** Device RGB -> linear sRGB (D65) matrix actually applied. */
  matrix: Mat3;
  convertPixel(r: number, g: number, b: number): Vec3;
  /** Convert every pixel of an RGBA buffer in place (alpha untouched). */
  convertRgbaInPlace(data: Uint8Array | Uint8ClampedArray): void;
};

/**
 * Build the device-RGB -> 8-bit sRGB transform for a matrix/TRC profile.
 *
 * The colorant columns live in the D50 PCS. For v4 and modern v2 profiles they
 * are already chromatically adapted (that is what `chad` documents), so their
 * sum is D50. Some old v2 profiles store unadapted colorants whose sum is the
 * media white (`wtpt`); in that case we Bradford-adapt that white to D50 first.
 * Then XYZ(D50) -> linear sRGB uses the Bradford-adapted sRGB matrix, which is
 * equivalent to adapting D50 -> D65 and applying the standard sRGB matrix.
 */
export function createSrgbConverter(profile: IccMatrixTrcProfile): SrgbConverter {
  let toPcs: Mat3 = [
    [profile.rXYZ[0], profile.gXYZ[0], profile.bXYZ[0]],
    [profile.rXYZ[1], profile.gXYZ[1], profile.bXYZ[1]],
    [profile.rXYZ[2], profile.gXYZ[2], profile.bXYZ[2]]
  ];
  const deviceWhite: Vec3 = [
    toPcs[0][0] + toPcs[0][1] + toPcs[0][2],
    toPcs[1][0] + toPcs[1][1] + toPcs[1][2],
    toPcs[2][0] + toPcs[2][1] + toPcs[2][2]
  ];
  const nearD50 = deviceWhite.every((value, index) => Math.abs(value - D50_WHITE[index]!) < 0.01);
  if (!nearD50 && deviceWhite[1] > 0) {
    toPcs = multiplyMat3(bradfordAdaptation(deviceWhite, D50_WHITE), toPcs);
  }
  const matrix = multiplyMat3(XYZ_D50_TO_SRGB, toPcs);
  const luts = profile.trc.map((curve) => {
    const lut = new Float64Array(256);
    for (let i = 0; i < 256; i += 1) lut[i] = evaluateToneCurve(curve, i / 255);
    return lut;
  }) as [Float64Array, Float64Array, Float64Array];
  const [m0, m1, m2] = matrix;
  const convertPixel = (r: number, g: number, b: number): Vec3 => {
    const lr = luts[0][r]!;
    const lg = luts[1][g]!;
    const lb = luts[2][b]!;
    return [
      encodeLinearToSrgb8(m0[0] * lr + m0[1] * lg + m0[2] * lb),
      encodeLinearToSrgb8(m1[0] * lr + m1[1] * lg + m1[2] * lb),
      encodeLinearToSrgb8(m2[0] * lr + m2[1] * lg + m2[2] * lb)
    ];
  };

  // sRGB-in-all-but-name check: near-identity matrix and every ramp (each
  // primary and grey) maps to itself. Then we skip the transform entirely so
  // sRGB-tagged and untagged files produce identical pixels.
  let identity = matrix.every((row, r) => row.every((value, c) => Math.abs(value - (r === c ? 1 : 0)) < 2e-3));
  for (let i = 0; identity && i < 256; i += 1) {
    const red = convertPixel(i, 0, 0);
    const green = convertPixel(0, i, 0);
    const blue = convertPixel(0, 0, i);
    const grey = convertPixel(i, i, i);
    identity =
      red[0] === i && red[1] === 0 && red[2] === 0 &&
      green[0] === 0 && green[1] === i && green[2] === 0 &&
      blue[0] === 0 && blue[1] === 0 && blue[2] === i &&
      grey[0] === i && grey[1] === i && grey[2] === i;
  }
  const [lutR, lutG, lutB] = luts;
  const convertRgbaInPlace = (data: Uint8Array | Uint8ClampedArray) => {
    for (let i = 0; i < data.length; i += 4) {
      const lr = lutR[data[i]!]!;
      const lg = lutG[data[i + 1]!]!;
      const lb = lutB[data[i + 2]!]!;
      data[i] = encodeLinearToSrgb8(m0[0] * lr + m0[1] * lg + m0[2] * lb);
      data[i + 1] = encodeLinearToSrgb8(m1[0] * lr + m1[1] * lg + m1[2] * lb);
      data[i + 2] = encodeLinearToSrgb8(m2[0] * lr + m2[1] * lg + m2[2] * lb);
    }
  };
  return { identity, matrix, convertPixel, convertRgbaInPlace };
}

export type SrgbConversionResult = {
  /** What happened, for diagnostics and the non-blocking UI note. */
  status: "untagged" | "srgb" | "converted" | "unsupported";
  profileDescription: string | null;
  /** Set when the image was treated as sRGB because its profile is not supported. */
  note: string | null;
};

/**
 * Convert an RGBA buffer in place from its embedded profile to sRGB.
 * Untagged images are sRGB by definition and left untouched.
 */
export function convertRgbaToSrgb(
  data: Uint8Array | Uint8ClampedArray,
  iccProfile: Uint8Array | null
): SrgbConversionResult {
  if (!iccProfile || iccProfile.length === 0) {
    return { status: "untagged", profileDescription: null, note: null };
  }
  const profile = parseIccProfile(iccProfile);
  if (profile.kind === "unsupported") {
    return {
      status: "unsupported",
      profileDescription: profile.description,
      note: `This image's color profile (${profile.description ?? profile.reason}) isn't supported; colors were read as sRGB and may be slightly off.`
    };
  }
  const converter = createSrgbConverter(profile);
  if (converter.identity) {
    return { status: "srgb", profileDescription: profile.description, note: null };
  }
  converter.convertRgbaInPlace(data);
  return { status: "converted", profileDescription: profile.description, note: null };
}
