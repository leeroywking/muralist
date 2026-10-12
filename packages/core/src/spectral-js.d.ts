// Minimal typings for spectral.js 3.x (MIT, https://github.com/rvanwijnen/spectral.js),
// which ships no type definitions. Only the surface used by the mix fit is
// declared.
declare module "spectral.js" {
  export class Color {
    constructor(value: string | number[]);
    /** Linear-light RGB, 0-1 per channel (may sit slightly outside gamut). */
    readonly lRGB: [number, number, number];
    /** sRGB, 0-255 per channel, rounded. */
    readonly sRGB: [number, number, number];
    tintingStrength: number;
  }
  /** Kubelka-Munk mix. Each entry is [color, factor]; factors are normalized. */
  export function mix(...colors: [Color, number][]): Color;
  const spectral: { Color: typeof Color; mix: typeof mix };
  export default spectral;
}
