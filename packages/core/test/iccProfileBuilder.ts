// Test-only author of minimal matrix/TRC ICC profiles. Used to generate the
// committed fixtures/display-p3-authored.icc (no third-party profile bytes in
// the repo) and to build variants (gamma, table, unadapted, CMYK) in tests.

export type BuilderCurve =
  | { type: "para"; functionType: number; params: number[] }
  | { type: "gamma"; gamma: number }
  | { type: "table"; table: number[] };

export type BuilderProfile = {
  description: string;
  version?: number; // major version byte, default 4
  colorSpace?: string; // default "RGB "
  pcs?: string; // default "XYZ "
  rXYZ?: [number, number, number];
  gXYZ?: [number, number, number];
  bXYZ?: [number, number, number];
  wtpt?: [number, number, number];
  trc?: BuilderCurve | [BuilderCurve, BuilderCurve, BuilderCurve];
};

function s15(value: number): number {
  return Math.round(value * 65536) | 0;
}

function xyzTag(v: [number, number, number]): Uint8Array {
  const out = new Uint8Array(20);
  const view = new DataView(out.buffer);
  out.set([0x58, 0x59, 0x5a, 0x20]); // "XYZ "
  view.setInt32(8, s15(v[0]));
  view.setInt32(12, s15(v[1]));
  view.setInt32(16, s15(v[2]));
  return out;
}

function curveTag(curve: BuilderCurve): Uint8Array {
  if (curve.type === "para") {
    const out = new Uint8Array(12 + curve.params.length * 4);
    const view = new DataView(out.buffer);
    out.set([0x70, 0x61, 0x72, 0x61]); // "para"
    view.setUint16(8, curve.functionType);
    curve.params.forEach((param, index) => view.setInt32(12 + index * 4, s15(param)));
    return out;
  }
  const entries = curve.type === "gamma" ? [Math.round(curve.gamma * 256)] : curve.table.map((v) => Math.round(v * 65535));
  const out = new Uint8Array(12 + entries.length * 2);
  const view = new DataView(out.buffer);
  out.set([0x63, 0x75, 0x72, 0x76]); // "curv"
  view.setUint32(8, entries.length);
  entries.forEach((entry, index) => view.setUint16(12 + index * 2, entry));
  return out;
}

function descTag(text: string): Uint8Array {
  // v2-style 'desc' (textDescriptionType): ASCII count + string + empty unicode/scriptcode.
  const out = new Uint8Array(12 + text.length + 1 + 4 + 4 + 2 + 1 + 67);
  const view = new DataView(out.buffer);
  out.set([0x64, 0x65, 0x73, 0x63]); // "desc"
  view.setUint32(8, text.length + 1);
  for (let i = 0; i < text.length; i += 1) out[12 + i] = text.charCodeAt(i);
  return out;
}

function ascii(text: string): number[] {
  return [...text].map((c) => c.charCodeAt(0));
}

export function buildIccProfile(spec: BuilderProfile): Uint8Array {
  const tags: [string, Uint8Array][] = [["desc", descTag(spec.description)]];
  if (spec.wtpt) tags.push(["wtpt", xyzTag(spec.wtpt)]);
  if (spec.rXYZ) tags.push(["rXYZ", xyzTag(spec.rXYZ)]);
  if (spec.gXYZ) tags.push(["gXYZ", xyzTag(spec.gXYZ)]);
  if (spec.bXYZ) tags.push(["bXYZ", xyzTag(spec.bXYZ)]);
  if (spec.trc) {
    const curves = Array.isArray(spec.trc) ? spec.trc : [spec.trc, spec.trc, spec.trc];
    tags.push(["rTRC", curveTag(curves[0])], ["gTRC", curveTag(curves[1])], ["bTRC", curveTag(curves[2])]);
  }
  const headerAndTable = 128 + 4 + tags.length * 12;
  let offset = headerAndTable;
  const placed = tags.map(([sig, data]) => {
    const start = offset;
    offset += data.length + ((4 - (data.length % 4)) % 4);
    return { sig, data, start };
  });
  const out = new Uint8Array(offset);
  const view = new DataView(out.buffer);
  view.setUint32(0, offset);
  out.set(ascii("mrlt"), 4);
  out[8] = spec.version ?? 4;
  out.set(ascii("mntr"), 12);
  out.set(ascii(spec.colorSpace ?? "RGB "), 16);
  out.set(ascii(spec.pcs ?? "XYZ "), 20);
  out.set(ascii("acsp"), 36);
  // PCS illuminant D50
  view.setInt32(68, s15(0.9642));
  view.setInt32(72, s15(1.0));
  view.setInt32(76, s15(0.8249));
  view.setUint32(128, tags.length);
  placed.forEach(({ sig, data, start }, index) => {
    const entry = 132 + index * 12;
    out.set(ascii(sig), entry);
    view.setUint32(entry + 4, start);
    view.setUint32(entry + 8, data.length);
    out.set(data, start);
  });
  return out;
}

/** The sRGB transfer function as an ICC parametric type-3 curve. */
export const SRGB_PARA: BuilderCurve = {
  type: "para",
  functionType: 3,
  params: [2.4, 1 / 1.055, 0.055 / 1.055, 1 / 12.92, 0.04045]
};

/**
 * Display P3 as Apple ships it: P3 primaries, D65 white, sRGB transfer curve;
 * colorants Bradford-adapted to the D50 PCS (values computed from the P3
 * primaries; independently authored, not copied from any vendor profile).
 */
export const DISPLAY_P3_SPEC: BuilderProfile = {
  description: "Display P3 (Muralist test profile)",
  wtpt: [0.9642, 1.0, 0.8249],
  rXYZ: [0.515092, 0.241178, -0.00105],
  gXYZ: [0.291953, 0.692243, 0.041881],
  bXYZ: [0.15713, 0.066575, 0.78424],
  trc: SRGB_PARA
};
