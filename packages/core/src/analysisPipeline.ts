// Browser-independent analysis pipeline, after decode: ICC -> sRGB at full
// resolution, deterministic box downscale to the analysis size, EXIF
// orientation, palette survey. Pure — apps/web only decodes bytes (with its
// own JS/WASM decoders, never a canvas) and calls this. See ./icc.ts for the
// product rule this enforces.

import { convertRgbaToSrgb, type SrgbConversionResult } from "./icc.js";
import { surveyPalette, type PaletteSurvey } from "./palette.js";
import {
  ANALYSIS_MAX_DIMENSION,
  applyExifOrientation,
  downscaleBoxRgba,
  getAnalysisDimensions,
  orientationSwapsAxes,
  type ImageContainerMetadata,
  type RgbaImage
} from "./raster.js";

export type PreparedAnalysisImage = {
  /** Upright, sRGB, analysis-size pixels: the single source for every calculation. */
  image: RgbaImage;
  color: SrgbConversionResult;
  /** Upright full-resolution size of the decoded file. */
  sourceWidth: number;
  sourceHeight: number;
};

/**
 * Turn full-resolution decoded pixels into the analysis image. Mutates
 * `decoded.data` (the ICC conversion runs in place to avoid a 36 MB copy).
 * Downscaling happens before the orientation transform — a box filter commutes
 * with flips/transposes, so this is exact and only remaps the small image.
 */
export function prepareAnalysisImage(
  decoded: RgbaImage,
  metadata: ImageContainerMetadata,
  maxDimension: number = ANALYSIS_MAX_DIMENSION
): PreparedAnalysisImage {
  const color = convertRgbaToSrgb(decoded.data, metadata.iccProfile);
  const swap = orientationSwapsAxes(metadata.orientation);
  const uprightWidth = swap ? decoded.height : decoded.width;
  const uprightHeight = swap ? decoded.width : decoded.height;
  const target = getAnalysisDimensions(uprightWidth, uprightHeight, maxDimension);
  const stored = downscaleBoxRgba(
    decoded,
    swap ? target.height : target.width,
    swap ? target.width : target.height
  );
  return {
    image: applyExifOrientation(stored, metadata.orientation),
    color,
    sourceWidth: uprightWidth,
    sourceHeight: uprightHeight
  };
}

export type ImageAnalysis = PreparedAnalysisImage & { survey: PaletteSurvey };

/** prepareAnalysisImage + surveyPalette. */
export function analyzeDecodedImage(
  decoded: RgbaImage,
  metadata: ImageContainerMetadata,
  maxDimension: number = ANALYSIS_MAX_DIMENSION
): ImageAnalysis {
  const prepared = prepareAnalysisImage(decoded, metadata, maxDimension);
  return { ...prepared, survey: surveyPalette(prepared.image) };
}
