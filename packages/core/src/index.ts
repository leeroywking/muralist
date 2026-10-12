import type { PaintBrandCatalog, PaintBrandPrices } from "@muralist/config";

export type AuthCapabilities = {
  mode: "oauth_only";
  providers: string[];
  guest: {
    enabled: true;
    canPersistData: false;
    restrictions: string[];
  };
};

export type EstimateInput = {
  brandId: string;
  areaSqFt: number;
  coats?: number;
  wasteFactor?: number;
  finishId?: string;
};

export type EstimateResult = {
  brandId: string;
  areaSqFt: number;
  coats: number;
  wasteFactor: number;
  finishId: string;
  coverageMultiplier: number;
  coverageSqFtPerGallon: number;
  recommendedGallons: number;
};

export type ColorCoverage = {
  id: string;
  coveragePercent: number;
  finishId?: string;
  coats?: number;
};

export type ContainerPlanEntry = {
  unit: "gallon" | "quart" | "sample";
  count: number;
};

// 8 fl oz / 128 fl oz per US gallon. Muralists use samples for detail colors
// where a quart would over-buy. Coverage is implicit via brand.coverage.default
// scaled by this volume fraction, so no separate sample_coverage_sqft is needed.
const SAMPLE_GALLONS = 1 / 16;

export type ColorContainerPlan = {
  colorId: string;
  finishId: string;
  coats: number;
  requiredGallons: number;
  packages: ContainerPlanEntry[];
  estimatedCost: number;
};

export type ContainerPlan = {
  perColor: ColorContainerPlan[];
  totals: {
    gallons: number;
    quarts: number;
    samples: number;
    estimatedCost: number;
  };
  currency: string;
};

export type SuggestContainersInput = {
  brandId: string;
  areaSqFt: number;
  coats?: number;
  wasteFactor?: number;
  defaultFinishId?: string;
  colors: ColorCoverage[];
};

export type WallDimensions = {
  widthFt: number;
  heightFt: number;
};

export type GridSpec = {
  cellSizeFt: number;
  columns: number;
  rows: number;
  cellAreaSqFt: number;
  hasPartialColumn: boolean;
  hasPartialRow: boolean;
  finalColumnWidthFt: number;
  finalRowHeightFt: number;
};

export type AspectRatioReport = {
  sourceAspectRatio: number;
  wallAspectRatio: number;
  ratioDelta: number;
  shouldWarn: boolean;
};

export type ColorAreaInput = {
  id: string;
  coveragePercent: number;
};

export type PaletteClassification = "buy" | "mix" | "absorb";

export type MixComponent = {
  colorId: string;
  fraction: number;
};

export type MixRecipe = {
  targetColorId: string;
  components: MixComponent[];
};

export type ClassifyPaletteInput = {
  id: string;
  rgb: [number, number, number];
  pixelCount: number;
};

export type ClassifyPaletteOptions = {
  /** Maximum OKLab distance (perceptual; ~0.02 is a just-noticeable
   * difference, black-to-white is 1.0) between a color and the closest point
   * on a two-color mixing line for it to count as a mix, and also the
   * near-duplicate merge distance. Lower = stricter, keeps more buy colors;
   * higher = more aggressive, collapses more onto mixing lines. */
  residualThreshold: number;
  /** Coverage percent threshold that splits mix (kept with recipe, >= threshold)
   * from absorb (silently folded into nearest endpoint, < threshold). A color
   * below it is absorbed only if it looks like that endpoint (within
   * 2x residualThreshold, OKLab) or is under 1% coverage (edge pixels);
   * otherwise it stays buy. */
  mixCoveragePercent: number;
  /** Colors covering at least this percent of the image (after near-duplicate
   * merging) are always buy — never a mix or absorb target. Default 15. */
  dominantCoveragePercent?: number;
  /** Ids of colors the user has locked to preserve small details. A locked
   * color is always buy: it is never absorbed (Phase 0 near-duplicate merge
   * included), never a mix target, and joins the buy set up front regardless
   * of coverage. Unlocked colors may still absorb into a locked color and may
   * use it as a mix partner (the usual partner-coverage rule applies). In a
   * near-duplicate pair with one locked member the unlocked member absorbs
   * into the locked one unless it is dominant (then both stay); two locked
   * colors never merge. Omitted or empty = no locks. */
  lockedIds?: ReadonlySet<string>;
};

export const DEFAULT_DOMINANT_COVERAGE_PERCENT = 15;

// See classifyPaletteColors: a mix partner must cover at least this share of
// what the mixed color covers. 0.5 leaves room for pixel-count noise across
// an evenly weighted gradient while blocking rare accents as partners.
const MIN_PARTNER_COVERAGE_RATIO = 0.5;

// Near-duplicate dedup (Phase 0) never merges two colors farther apart than
// this OKLab distance, whatever the preset. ~0.02 is a just-noticeable
// difference; at 0.05 (2.5 JNDs) two flat areas side by side still read as
// "the same paint" at mural distance. The aggressive preset (0.07) used to
// dedup at its full threshold, which merged Coral's flat red #D93A48 into the
// magenta #DA246D (0.065 apart) — two reds a painter keeps separate. Wider
// gaps are left to the mix-line test, which keeps a recipe (or the absorb
// distance limit below).
const MAX_DEDUP_DISTANCE = 0.05;

// A color below mixCoveragePercent that fits a mixing line is absorbed into
// the nearer line endpoint only if it is within ABSORB_DISTANCE_FACTOR x the
// residual threshold of it (OKLab). The residual threshold is the user's
// "how far off may a painted color be" tolerance; snapping a color along the
// line moves it further than the residual, so the limit is twice the
// threshold (Conservative 0.04, Balanced 0.08, Aggressive 0.14). That folds
// in shades that look like their endpoint and keeps a distinct small color
// such as the octopus's light-pink suckers (#FDB2C0, 0.17-0.18 from both its
// pink and white endpoints, so it used to be painted white or tan).
const ABSORB_DISTANCE_FACTOR = 2;

// Colors below this coverage percent that fit a line between two buy colors
// absorb regardless of the distance limit: they are anti-aliasing / JPEG
// edge pixels between two flat areas. The analyzer samples <= 22,000 pixels
// of an image scaled to <= 320 px, so a 1-px seam running the full width is
// at most ~320 px (~1.5%), and it splits across at least two blend buckets
// (~0.75% each). 1% catches those with margin. On the real test images the
// small details that must survive sit above it (octopus suckers 3.2-3.6%,
// Coral red 6.3%, FlowerRepeat #D8798E 1.7%), while the 0.5-0.8% greys
// between Mazdarati's black and white are seams. 0.5% kept those greys and
// added 3-6 chips per image at Balanced.
const EDGE_COVERAGE_PERCENT = 1;

// --- Paint plausibility (see isPlausibleMix) --------------------------------
// Measured in OKLCh: L = value (0-1), C = chroma, h = hue angle.
//
// Below this chroma a color is treated as hueless (white, black, greys).
// White/black/neutral greys from real palettes measure C < 0.01 and warm
// greiges up to ~0.02; the FlowerRepeat navy #313D52 (C 0.040) is a real
// blue and must keep its hue.
const NEUTRAL_CHROMA = 0.025;
// Chroma slack: mixing never raises chroma, so the target may not be more
// saturated than the more saturated partner (the ceiling). Straight sRGB
// lerps bend slightly in OKLab, but none of the 84 CSV fixture steps exceeds
// the ceiling (closest is 0.006 under). 0.012 covers quantisation noise and
// still rejects FlowerRepeat's dark yellow #F5C233 (C 0.158) from light
// yellow (0.141) + navy (0.040), 0.017 over. The same slack is used for the
// near-complement bound below.
const CHROMA_CEILING_TOLERANCE = 0.012;
// Value bracket slack: base + per-chroma term. sRGB midpoints of two
// saturated colors of similar value come out lighter than both in OKLab
// (CSV "Bright Red to Royal Blue" steps are up to 0.054 lighter than either
// end, "Green to Red" 0.028), and the effect scales with the partners'
// chroma. 0.02 + 0.2 x the duller partner's chroma gives 0.066 there and
// ~0.02 when a partner is white/black/grey, so tints and shades get a tight
// bracket.
const VALUE_BRACKET_TOLERANCE = 0.02;
const VALUE_BRACKET_CHROMA_SLOPE = 0.2;
// Hue slack for tints/shades (one neutral partner), in degrees. Tints keep
// hue, but an sRGB lerp toward white drifts: CSV "Indigo to white" steps
// drift up to 15 degrees (the familiar blue-to-purple shift), "Cyan to
// White" 7. 20 degrees covers those and still rejects a tint whose hue the
// partner does not have.
const TINT_HUE_TOLERANCE_DEGREES = 20;
// Slack outside the shorter hue arc between two chromatic partners,
// measured on the a/b plane (chroma x off-arc angle in radians) so that hue
// noise in low-chroma colors does not count as much as a visible hue shift
// in a saturated one. Every CSV step between two chromatic,
// non-complementary colors lies on the arc (0 off); one 8-bit sRGB step
// moves a/b by ~0.003-0.005. 0.008 allows that noise and rejects
// FlowerRepeat's dark yellow (h 87.5, C 0.158) from light yellow (h 92.3) +
// green #84B73F (h ~128): it sits 4.8 degrees outside the arc, 0.013 on
// the a/b plane — more orange than either partner.
const ARC_HUE_TOLERANCE = 0.008;
// Partners at least this far apart in hue are near-complements: their mixes
// pass through grey, so "between" has no meaning and the hue-arc check is
// skipped. For any two chromatic partners (complements included) the target
// may not exceed their chroma interpolated at the recipe fraction (the
// triangle inequality on the OKLab a/b plane — complements dull, and 8%
// pink cannot turn FlowerRepeat's navy #313D52, C 0.040, into the purple
// #47315E, C 0.079). This is looser than the "below both partners' chroma"
// rule for complements, which straight sRGB lerps break near the saturated
// end (CSV "Indigo to desaturated Yellow" 80/20 is C 0.156 against partners
// 0.189 / 0.067), and the worst interpolated excess across all 84 CSV steps
// is 0.005, inside CHROMA_CEILING_TOLERANCE. Tints and shades (one neutral
// partner) are exempt: the sRGB fraction of white is not a paint fraction,
// and light yellow #F9D55F really is white + dark yellow #F5C233.
const COMPLEMENT_HUE_DEGREES = 150;

export type ClassifiedColor = {
  id: string;
  classification: PaletteClassification;
  absorbedIntoId?: string;
  recipe?: MixRecipe;
};

export type WorkspaceContent =
  | { kind: "blank" }
  | { kind: "mixes"; mixes: MixRecipe[] };

export type ColorAreaEstimate = {
  id: string;
  coveragePercent: number;
  areaSqFt: number;
};

export function buildMaquetteFileName(uploadedFileName: string): string {
  const trimmed = uploadedFileName.trim();
  if (!trimmed) {
    return "muralist_maquette";
  }

  const lastSegment = trimmed.split(/[\\/]/).pop() ?? trimmed;
  const withoutExtension = lastSegment.replace(/\.[^.]+$/, "");
  const safeBase = withoutExtension
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "");

  return `${safeBase || "muralist"}_maquette`;
}

export function getAuthCapabilities(): AuthCapabilities {
  return {
    mode: "oauth_only",
    providers: ["google", "apple", "facebook"],
    guest: {
      enabled: true,
      canPersistData: false,
      restrictions: [
        "No saved projects",
        "No personal paint library",
        "No cross-device history"
      ]
    }
  };
}

export function deriveGridSpec(
  wall: WallDimensions,
  cellSizeFt: number
): GridSpec {
  assertPositiveFinite("Wall width", wall.widthFt);
  assertPositiveFinite("Wall height", wall.heightFt);
  assertPositiveFinite("Grid cell size", cellSizeFt);

  const columns = Math.ceil(wall.widthFt / cellSizeFt);
  const rows = Math.ceil(wall.heightFt / cellSizeFt);
  const finalColumnWidthFt = remainderOrFull(wall.widthFt, cellSizeFt);
  const finalRowHeightFt = remainderOrFull(wall.heightFt, cellSizeFt);

  return {
    cellSizeFt,
    columns,
    rows,
    cellAreaSqFt: cellSizeFt * cellSizeFt,
    hasPartialColumn: finalColumnWidthFt < cellSizeFt,
    hasPartialRow: finalRowHeightFt < cellSizeFt,
    finalColumnWidthFt,
    finalRowHeightFt
  };
}

export function compareAspectRatios(
  source: { widthPx: number; heightPx: number },
  wall: WallDimensions,
  warningThreshold = 0.05
): AspectRatioReport {
  assertPositiveFinite("Source width", source.widthPx);
  assertPositiveFinite("Source height", source.heightPx);
  assertPositiveFinite("Wall width", wall.widthFt);
  assertPositiveFinite("Wall height", wall.heightFt);
  assertPositiveFinite("Warning threshold", warningThreshold);

  const sourceAspectRatio = source.widthPx / source.heightPx;
  const wallAspectRatio = wall.widthFt / wall.heightFt;
  const ratioDelta = wallAspectRatio / sourceAspectRatio;

  return {
    sourceAspectRatio,
    wallAspectRatio,
    ratioDelta,
    shouldWarn: Math.abs(Math.log(ratioDelta)) > warningThreshold
  };
}

export function deriveColorAreaEstimates(
  wallAreaSqFt: number,
  colors: ColorAreaInput[]
): ColorAreaEstimate[] {
  assertPositiveFinite("Wall area", wallAreaSqFt);

  return colors.map((color) => {
    if (!Number.isFinite(color.coveragePercent) || color.coveragePercent < 0) {
      throw new Error(`Color ${color.id} coveragePercent must be zero or greater.`);
    }

    return {
      id: color.id,
      coveragePercent: color.coveragePercent,
      areaSqFt: wallAreaSqFt * (color.coveragePercent / 100)
    };
  });
}

export function estimatePaintRequirement(
  input: EstimateInput,
  catalog: PaintBrandCatalog
): EstimateResult {
  const brand = catalog.brands.find((entry) => entry.id === input.brandId);

  if (!brand) {
    throw new Error(`Unknown brand: ${input.brandId}`);
  }

  if (input.areaSqFt <= 0) {
    throw new Error("Area must be greater than zero.");
  }

  const finishId = input.finishId ?? brand.finishes[0]!.id;
  const finish = brand.finishes.find((entry) => entry.id === finishId);

  if (!finish) {
    throw new Error(`Unknown finishId for brand ${brand.id}: ${finishId}`);
  }

  const coats = input.coats ?? brand.default_coats;
  const wasteFactor = input.wasteFactor ?? 0.1;
  const effectiveCoverage = brand.coverage.default * finish.coverage_multiplier;
  const rawGallons = (input.areaSqFt * coats * (1 + wasteFactor)) / effectiveCoverage;

  return {
    brandId: brand.id,
    areaSqFt: input.areaSqFt,
    coats,
    wasteFactor,
    finishId,
    coverageMultiplier: finish.coverage_multiplier,
    coverageSqFtPerGallon: effectiveCoverage,
    recommendedGallons: roundToTenths(rawGallons)
  };
}

export function suggestContainersForColors(
  input: SuggestContainersInput,
  catalog: PaintBrandCatalog
): ContainerPlan {
  const brand = catalog.brands.find((entry) => entry.id === input.brandId);

  if (!brand) {
    throw new Error(`Unknown brand: ${input.brandId}`);
  }

  if (input.areaSqFt <= 0) {
    throw new Error("Area must be greater than zero.");
  }

  const coats = input.coats ?? brand.default_coats;
  const wasteFactor = input.wasteFactor ?? 0.1;
  const defaultFinishId = input.defaultFinishId ?? brand.finishes[0]!.id;

  if (!brand.finishes.some((entry) => entry.id === defaultFinishId)) {
    throw new Error(`Unknown finishId for brand ${brand.id}: ${defaultFinishId}`);
  }

  const perColor: ColorContainerPlan[] = input.colors.map((color) => {
    const finishId = color.finishId ?? defaultFinishId;
    const finish = brand.finishes.find((entry) => entry.id === finishId);

    if (!finish) {
      throw new Error(`Unknown finishId for brand ${brand.id}: ${finishId}`);
    }

    const colorCoats = color.coats ?? coats;
    if (!(colorCoats > 0)) {
      throw new Error(`Color ${color.id} coats must be greater than zero.`);
    }

    const effectiveCoverage = brand.coverage.default * finish.coverage_multiplier;
    const colorArea = input.areaSqFt * (color.coveragePercent / 100);
    const requiredGallons = (colorArea * colorCoats * (1 + wasteFactor)) / effectiveCoverage;
    const packages = packContainersForColor(requiredGallons, brand.prices);
    const estimatedCost = computePackageCost(packages, brand.prices);

    return {
      colorId: color.id,
      finishId,
      coats: colorCoats,
      requiredGallons,
      packages,
      estimatedCost
    };
  });

  const totals = perColor.reduce(
    (acc, plan) => {
      for (const entry of plan.packages) {
        if (entry.unit === "gallon") {
          acc.gallons += entry.count;
        } else if (entry.unit === "quart") {
          acc.quarts += entry.count;
        } else {
          acc.samples += entry.count;
        }
      }
      acc.estimatedCost += plan.estimatedCost;
      return acc;
    },
    { gallons: 0, quarts: 0, samples: 0, estimatedCost: 0 }
  );

  return { perColor, totals, currency: brand.prices.currency };
}

function computePackageCost(
  packages: ContainerPlanEntry[],
  prices: PaintBrandPrices
): number {
  return packages.reduce((sum, entry) => {
    if (entry.unit === "gallon") {
      return sum + entry.count * prices.gallon;
    }
    if (entry.unit === "quart") {
      return sum + entry.count * prices.quart;
    }
    return sum + entry.count * prices.sample;
  }, 0);
}

function packContainersForColor(
  requiredGallons: number,
  prices: PaintBrandPrices
): ContainerPlanEntry[] {
  // D (sample-first regime): detail colors whose total need fits in samples,
  // and where samples cost less than a quart for that need, pack as samples.
  // This captures "muralists use 8oz samples for detail colors."
  if (requiredGallons <= 0) {
    // E: at least one container even when coverage is trivially zero.
    return prices.sample < prices.quart
      ? [{ unit: "sample", count: 1 }]
      : [{ unit: "quart", count: 1 }];
  }
  const samplesForWhole = Math.max(1, Math.ceil(requiredGallons / SAMPLE_GALLONS));
  if (
    requiredGallons <= SAMPLE_GALLONS &&
    prices.sample < prices.quart
  ) {
    return [{ unit: "sample", count: 1 }];
  }
  if (
    samplesForWhole * SAMPLE_GALLONS <= 0.25 &&
    samplesForWhole * prices.sample < prices.quart
  ) {
    return [{ unit: "sample", count: samplesForWhole }];
  }

  // E: fall-through baseline = at least one quart.
  const effectiveGallons = Math.max(0.25, requiredGallons);
  const wholeGallons = Math.floor(effectiveGallons);
  const remainder = effectiveGallons - wholeGallons;
  const quartsNeeded = remainder > 0 ? Math.ceil(remainder / 0.25) : 0;

  // G: if the quart portion costs at least as much as a gallon, take the gallon instead.
  const roundUpToGallon = quartsNeeded > 0 && quartsNeeded * prices.quart >= prices.gallon;

  const finalGallons = roundUpToGallon ? wholeGallons + 1 : wholeGallons;
  const finalQuarts = roundUpToGallon ? 0 : quartsNeeded;

  const entries: ContainerPlanEntry[] = [];
  if (finalGallons > 0) {
    entries.push({ unit: "gallon", count: finalGallons });
  }
  if (finalQuarts > 0) {
    entries.push({ unit: "quart", count: finalQuarts });
  }
  if (entries.length === 0) {
    entries.push({ unit: "quart", count: 1 });
  }
  return entries;
}

function roundToTenths(value: number) {
  return Math.round(value * 10) / 10;
}

function assertPositiveFinite(label: string, value: number) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be greater than zero.`);
  }
}

function remainderOrFull(value: number, divisor: number) {
  const remainder = value % divisor;
  return nearlyEqual(remainder, 0) ? divisor : remainder;
}

function nearlyEqual(left: number, right: number) {
  return Math.abs(left - right) < 1e-9;
}

export function classifyPaletteColors(
  colors: ClassifyPaletteInput[],
  options: ClassifyPaletteOptions
): ClassifiedColor[] {
  assertPositiveFinite("Residual threshold", options.residualThreshold);
  if (!Number.isFinite(options.mixCoveragePercent) || options.mixCoveragePercent < 0) {
    throw new Error("Mix coverage percent must be zero or greater.");
  }
  const dominantCoveragePercent =
    options.dominantCoveragePercent ?? DEFAULT_DOMINANT_COVERAGE_PERCENT;
  if (!Number.isFinite(dominantCoveragePercent) || dominantCoveragePercent < 0) {
    throw new Error("Dominant coverage percent must be zero or greater.");
  }

  const totalPixels = colors.reduce((sum, color) => sum + color.pixelCount, 0);
  if (totalPixels <= 0 || colors.length === 0) {
    return [];
  }

  // Phase 0: near-duplicate dedup. Real-image palettes capture many colors
  // that are perceptual neighbors without being on a three-point mixing
  // line. Any pair closer than the residual threshold (OKLab distance,
  // capped at MAX_DEDUP_DISTANCE) is merged — the lower-coverage member absorbs into the higher-coverage
  // one, silently (no mix recipe). Survivor pixel counts include the
  // pixels they absorbed. A dominant color is never the absorbed member.
  const isLockedId = (id: string) => options.lockedIds?.has(id) ?? false;
  const dedupResult = dedupNearestNeighbors(
    colors,
    Math.min(options.residualThreshold, MAX_DEDUP_DISTANCE),
    (dominantCoveragePercent / 100) * totalPixels,
    isLockedId
  );
  const survivors = dedupResult.survivors;
  const dedupAbsorbs = dedupResult.absorbs; // id -> keeperId

  const coverageOf = (color: ClassifyPaletteInput) => (color.pixelCount / totalPixels) * 100;
  const isDominant = (color: ClassifyPaletteInput) =>
    coverageOf(color) >= dominantCoveragePercent;

  // A color may only be mixed from buy colors that each cover at least
  // MIN_PARTNER_COVERAGE_RATIO of what it covers. Mixing an 8% color from a
  // 1% accent means buying the accent in bulk for someone else's sake and
  // is how a rarely used indigo ended up as a partner over a closer, more
  // common color. In the greedy pass below this holds automatically (every
  // earlier buy has at least as many pixels); the explicit filter keeps the
  // settle pass and seeded locked colors to the same rule.
  const ordered = [...survivors].sort(
    (left, right) => right.pixelCount - left.pixelCount || left.id.localeCompare(right.id)
  );
  const buyIds = new Set<string>();
  const fitFromBuys = (color: ClassifyPaletteInput) =>
    findBestMixingPair(
      color,
      ordered.filter(
        (entry) =>
          buyIds.has(entry.id) &&
          entry.id !== color.id &&
          entry.pixelCount >= color.pixelCount * MIN_PARTNER_COVERAGE_RATIO
      ),
      options.residualThreshold
    );

  // A color that fits a line is only taken out of the buy set if the result
  // still looks like it: at or above mixCoveragePercent it keeps a recipe
  // (exact color); below, it is absorbed into the nearer endpoint only if
  // that endpoint is within the absorb distance limit, or if it is
  // sub-EDGE_COVERAGE_PERCENT edge clutter. Otherwise it stays a buy color.
  const absorbDistanceLimit = ABSORB_DISTANCE_FACTOR * options.residualThreshold;
  const labOf = new Map(colors.map((color) => [color.id, rgbToOklab(color.rgb)]));
  const absorbTargetOf = (fit: NonNullable<ReturnType<typeof fitFromBuys>>) =>
    fit.t < 0.5 ? fit.endpointA : fit.endpointB;
  const nonBuyFit = (color: ClassifyPaletteInput) => {
    const fit = fitFromBuys(color);
    if (!fit) return null;
    const coverage = coverageOf(color);
    if (coverage >= options.mixCoveragePercent || coverage < EDGE_COVERAGE_PERCENT) return fit;
    const distance = oklabDistance(labOf.get(color.id)!, labOf.get(absorbTargetOf(fit).id)!);
    return distance <= absorbDistanceLimit ? fit : null;
  };

  // Phase 1: greedy, coverage-ordered buy set. Survivors are visited from
  // most to least used. Each one is tested against the buy set built so far:
  // if two existing buy colors mix to it within the threshold it is a mix
  // target, otherwise it joins the buy set. Common colors therefore become
  // partners before rare ones, and a partner is always a buy color — the old
  // "is it bracketed by any two others?" test let two colors disqualify each
  // other and fell back to white + black for anything between them.
  // Dominant colors (>= dominantCoveragePercent of the image) always buy.
  // Locked colors are seeded into the buy set before the greedy pass so a
  // small locked accent is already available as a partner when larger
  // colors are tested (subject to the partner-coverage rule above).
  for (const color of ordered) {
    if (isLockedId(color.id)) buyIds.add(color.id);
  }
  for (const color of ordered) {
    if (buyIds.has(color.id)) continue;
    if (isDominant(color) || !nonBuyFit(color)) {
      buyIds.add(color.id);
    }
  }

  // Phase 2: settle. Greedy order alone cannot collapse a gradient whose
  // steps cover about the same area — the first two steps visited become
  // buys and every later step only extends the line. So a non-dominant buy
  // that now sits between two other (eligible) buys is demoted, least-used
  // first. Demotion can strand a mix whose partner it removed, so any
  // non-buy that no longer fits joins the buy set and the loop repeats.
  // Bounded by the survivor count.
  for (let pass = 0; pass < survivors.length; pass += 1) {
    let changed = false;
    const ascendingBuys = ordered.filter((entry) => buyIds.has(entry.id)).reverse();
    for (const color of ascendingBuys) {
      if (isDominant(color) || isLockedId(color.id)) continue;
      if (nonBuyFit(color)) {
        buyIds.delete(color.id);
        changed = true;
      }
    }
    for (const color of ordered) {
      if (buyIds.has(color.id)) continue;
      if (!nonBuyFit(color)) {
        buyIds.add(color.id);
        changed = true;
      }
    }
    if (!changed) break;
  }

  // Phase 3: classify every non-buy survivor against the final buy set as
  // mix (coverage >= mixCoveragePercent, keeps a recipe) or absorb (folds
  // into the nearer partner).
  const classifications = new Map<string, ClassifiedColor>();
  for (const color of survivors) {
    if (buyIds.has(color.id)) {
      classifications.set(color.id, { id: color.id, classification: "buy" });
      continue;
    }
    const fit = nonBuyFit(color);
    if (!fit) {
      // Unreachable after Phase 2 settles; kept as a safe default.
      classifications.set(color.id, { id: color.id, classification: "buy" });
      continue;
    }
    const { endpointA, endpointB, t } = fit;
    if (coverageOf(color) >= options.mixCoveragePercent) {
      classifications.set(color.id, {
        id: color.id,
        classification: "mix",
        recipe: {
          targetColorId: color.id,
          components: [
            { colorId: endpointA.id, fraction: round4(1 - t) },
            { colorId: endpointB.id, fraction: round4(t) }
          ]
        }
      });
    } else {
      classifications.set(color.id, {
        id: color.id,
        classification: "absorb",
        absorbedIntoId: absorbTargetOf(fit).id
      });
    }
  }

  // Merge dedup-absorbed entries into the final output.
  for (const [absorbedId, keeperId] of dedupAbsorbs.entries()) {
    classifications.set(absorbedId, {
      id: absorbedId,
      classification: "absorb",
      absorbedIntoId: keeperId
    });
  }

  // Final path compression across the full classification map. A Phase 0
  // keeper can itself be classified as absorb in Phase 3 (it survived dedup
  // but turned out to be on a mixing line). Without this walk, colors that
  // Phase 0 routed to that keeper now point at an absorbed id, and
  // applyClassification's pixelCount fold throws when it hits the stale
  // reference.
  //
  // A Phase 0 keeper can also end up a mix (nothing dominant pins it to buy,
  // and it sits on a line between two buys). Its near-duplicates would then
  // absorb into a color nobody buys, so each one folds into whichever of the
  // mix's two components is nearer to it (OKLab) — the nearer-endpoint rule
  // Phase 3 uses for low-coverage mixes. Recipe components are always buys.
  for (const [id, entry] of classifications.entries()) {
    if (entry.classification !== "absorb" || !entry.absorbedIntoId) continue;
    let target = entry.absorbedIntoId;
    const visited = new Set<string>([id]);
    while (!visited.has(target)) {
      visited.add(target);
      const next = classifications.get(target);
      if (next?.classification === "mix" && next.recipe) {
        const [componentA, componentB] = next.recipe.components;
        const lab = labOf.get(id)!;
        target =
          oklabDistance(lab, labOf.get(componentA!.colorId)!) <=
          oklabDistance(lab, labOf.get(componentB!.colorId)!)
            ? componentA!.colorId
            : componentB!.colorId;
        break;
      }
      if (!next || next.classification !== "absorb" || !next.absorbedIntoId) break;
      target = next.absorbedIntoId;
    }
    if (target !== entry.absorbedIntoId) {
      classifications.set(id, { ...entry, absorbedIntoId: target });
    }
  }

  return colors.map((color) => classifications.get(color.id)!);
}

function dedupNearestNeighbors(
  colors: ClassifyPaletteInput[],
  threshold: number,
  dominantPixelCount: number,
  isLocked: (id: string) => boolean
): { survivors: ClassifyPaletteInput[]; absorbs: Map<string, string> } {
  const survivors: ClassifyPaletteInput[] = colors.map((color) => ({ ...color }));
  const absorbs = new Map<string, string>();
  // Distances are OKLab (perceptual). A keeper keeps its own rgb when it
  // absorbs a neighbor, so each color's OKLab point is computed once.
  const labById = new Map(colors.map((color) => [color.id, rgbToOklab(color.rgb)]));

  // Repeated nearest-pair merge. Each pass picks the tightest pair; the
  // lower-pixelCount member absorbs into the higher-pixelCount one. A locked
  // member is never the absorbed one: with exactly one locked member the
  // other absorbs into it (unless that other is dominant), and two locked
  // colors are never merged. Bounded
  // by colors.length iterations so worst-case is O(N^3) — fine for palettes
  // under ~100 colors.
  while (survivors.length > 1) {
    let bestDistance = Infinity;
    let keeperIndex = -1;
    let absorbedIndex = -1;

    for (let i = 0; i < survivors.length; i += 1) {
      for (let j = i + 1; j < survivors.length; j += 1) {
        const a = survivors[i]!;
        const b = survivors[j]!;
        const distance = oklabDistance(labById.get(a.id)!, labById.get(b.id)!);
        if (distance >= threshold) continue;
        const aLocked = isLocked(a.id);
        const bLocked = isLocked(b.id);
        if (aLocked && bLocked) continue;
        // Keeper = the locked member if there is one; otherwise the one with
        // more pixels, or lexicographically smaller id on ties for
        // deterministic test output.
        const aKeeps = aLocked
          ? true
          : bLocked
            ? false
            : a.pixelCount > b.pixelCount ||
              (a.pixelCount === b.pixelCount && a.id.localeCompare(b.id) <= 0);
        // A dominant color is never the absorbed member. Without locks the
        // absorbed member is the smaller one, so if it is dominant both are,
        // and two dominant colors both stay.
        if ((aKeeps ? b : a).pixelCount >= dominantPixelCount) continue;
        if (distance < bestDistance) {
          bestDistance = distance;
          if (aKeeps) {
            keeperIndex = i;
            absorbedIndex = j;
          } else {
            keeperIndex = j;
            absorbedIndex = i;
          }
        }
      }
    }

    if (bestDistance === Infinity) break;

    const keeper = survivors[keeperIndex]!;
    const absorbed = survivors[absorbedIndex]!;

    // Path-compress absorbs: if the keeper itself was later absorbed, the
    // final keeper is the root of the absorb chain. (Cannot happen in this
    // forward pass, but defensive.)
    let finalKeeperId = keeper.id;
    while (absorbs.has(finalKeeperId)) {
      finalKeeperId = absorbs.get(finalKeeperId)!;
    }

    absorbs.set(absorbed.id, finalKeeperId);
    // Redirect any prior absorbers that pointed at `absorbed`. Collect
    // updates first so we don't mutate the Map during its own iteration.
    const redirectIds: string[] = [];
    for (const [id, target] of absorbs.entries()) {
      if (target === absorbed.id) redirectIds.push(id);
    }
    for (const id of redirectIds) {
      absorbs.set(id, finalKeeperId);
    }

    keeper.pixelCount += absorbed.pixelCount;
    survivors.splice(absorbedIndex, 1);
  }

  // Final safety pass: resolve any remaining transitive chains so every
  // absorbedId points directly at a survivor (not at another absorbed id).
  for (const id of Array.from(absorbs.keys())) {
    let target = absorbs.get(id)!;
    const visited = new Set<string>([id]);
    while (absorbs.has(target) && !visited.has(target)) {
      visited.add(target);
      target = absorbs.get(target)!;
    }
    absorbs.set(id, target);
  }

  return { survivors, absorbs };
}

// Among pairs that fit under the threshold, a pair counts as "clearly better"
// on residual only when it beats the best residual by more than this share
// of the threshold. Inside that band, partner coverage decides.
const PARTNER_RESIDUAL_SLACK = 0.25;

/**
 * Find the two buy colors that best mix to `candidate`.
 *
 * Fit (Variant A): the mix path is the straight sRGB line between the two
 * buy colors — digital gradient tools interpolate in sRGB. `t` is the
 * candidate's projection onto that line in sRGB; the residual is the OKLab
 * distance between the candidate and the sRGB point at `t`, so the
 * tolerance is perceptual and a hue the line misses (white + black for a
 * teal) costs its full chroma difference.
 *
 * Every candidate pair must also pass isPlausibleMix (paint-plausibility):
 * being near the sRGB line is not enough if a painter could not get there.
 *
 * Scoring: let `best` be the lowest residual among fitting pairs. Every pair
 * within `best + PARTNER_RESIDUAL_SLACK * threshold` is acceptable; among
 * those, pick the pair whose less-used partner has the most pixels (a
 * painter would rather mix from paint they are buying plenty of), then the
 * lower residual, then the higher combined pixel count.
 */
function findBestMixingPair(
  candidate: ClassifyPaletteInput,
  buyColors: ClassifyPaletteInput[],
  residualThreshold: number
): { endpointA: ClassifyPaletteInput; endpointB: ClassifyPaletteInput; t: number; residual: number } | null {
  if (buyColors.length < 2) return null;

  const candidateLab = rgbToOklab(candidate.rgb);
  const candidateLch = oklabToLch(candidateLab);
  const fits: {
    endpointA: ClassifyPaletteInput;
    endpointB: ClassifyPaletteInput;
    t: number;
    residual: number;
  }[] = [];

  for (let i = 0; i < buyColors.length; i += 1) {
    for (let j = i + 1; j < buyColors.length; j += 1) {
      const a = buyColors[i]!;
      const b = buyColors[j]!;
      const fit = projectOntoSegment(candidate.rgb, candidateLab, a.rgb, b.rgb);
      if (fit === null) continue;
      if (fit.residual > residualThreshold) continue;
      if (
        !isPlausibleMix(candidateLch, oklabToLch(rgbToOklab(a.rgb)), oklabToLch(rgbToOklab(b.rgb)), fit.t)
      ) {
        continue;
      }
      fits.push({ endpointA: a, endpointB: b, t: fit.t, residual: fit.residual });
    }
  }

  if (fits.length === 0) return null;

  const bestResidual = Math.min(...fits.map((fit) => fit.residual));
  const cutoff = bestResidual + PARTNER_RESIDUAL_SLACK * residualThreshold;
  let best: (typeof fits)[number] | null = null;
  let bestMinPixels = -Infinity;
  let bestCombined = -Infinity;
  for (const fit of fits) {
    if (fit.residual > cutoff) continue;
    const minPixels = Math.min(fit.endpointA.pixelCount, fit.endpointB.pixelCount);
    const combined = fit.endpointA.pixelCount + fit.endpointB.pixelCount;
    if (
      !best ||
      minPixels > bestMinPixels ||
      (minPixels === bestMinPixels &&
        (fit.residual < best.residual - 1e-9 ||
          (Math.abs(fit.residual - best.residual) <= 1e-9 && combined > bestCombined)))
    ) {
      best = fit;
      bestMinPixels = minPixels;
      bestCombined = combined;
    }
  }

  return best;
}

type Lch = { L: number; C: number; h: number };

function oklabToLch(lab: readonly [number, number, number]): Lch {
  const h = (Math.atan2(lab[2], lab[1]) * 180) / Math.PI;
  return { L: lab[0], C: Math.hypot(lab[1], lab[2]), h: h < 0 ? h + 360 : h };
}

/** Smallest angle between two hues, 0-180 degrees. */
function hueDistance(left: number, right: number): number {
  const d = Math.abs(left - right) % 360;
  return d > 180 ? 360 - d : d;
}

/**
 * Paint-plausibility of making `target` from partners `a` and `b`, with `t`
 * the fraction of `b` (0 = all `a`). Real paint mixing never raises chroma,
 * never leaves the partners' value range, and keeps hue between the
 * partners; a color that only happens to sit near the sRGB line between two
 * buy colors (dark yellow "from" light yellow + navy, a blush "from" white +
 * teal) fails one of these. Tolerances and their calibration are documented
 * at the constants above.
 */
function isPlausibleMix(target: Lch, a: Lch, b: Lch, t: number): boolean {
  // a. Chroma ceiling.
  if (target.C > Math.max(a.C, b.C) + CHROMA_CEILING_TOLERANCE) return false;

  // b. Value bracket.
  const valueTolerance =
    VALUE_BRACKET_TOLERANCE + VALUE_BRACKET_CHROMA_SLOPE * ((a.C + b.C) / 2);
  if (target.L > Math.max(a.L, b.L) + valueTolerance) return false;
  if (target.L < Math.min(a.L, b.L) - valueTolerance) return false;

  // c. Hue. A near-neutral target has no meaningful hue.
  if (target.C < NEUTRAL_CHROMA) return true;
  const aNeutral = a.C < NEUTRAL_CHROMA;
  const bNeutral = b.C < NEUTRAL_CHROMA;
  // Two neutrals cannot make a chromatic color.
  if (aNeutral && bNeutral) return false;
  // Tint or shade: keeps the chromatic partner's hue.
  if (aNeutral || bNeutral) {
    const chromatic = aNeutral ? b : a;
    return hueDistance(target.h, chromatic.h) <= TINT_HUE_TOLERANCE_DEGREES;
  }
  // Two chromatic partners: no more chroma than theirs interpolated at the
  // recipe fraction (8% pink cannot double a navy's chroma), which is also
  // what makes near-complements dull toward grey.
  if (target.C > (1 - t) * a.C + t * b.C + CHROMA_CEILING_TOLERANCE) return false;
  const partnerSpread = hueDistance(a.h, b.h);
  // Near-complements: "between" has no meaning; the chroma bound decides.
  if (partnerSpread >= COMPLEMENT_HUE_DEGREES) return true;
  // On the shorter arc between the partners (+- tolerance): the target's
  // distances to both ends add up to the arc length when it lies on it, and
  // the excess is twice the angle by which it overshoots the nearer end.
  const offArcDegrees =
    (hueDistance(target.h, a.h) + hueDistance(target.h, b.h) - partnerSpread) / 2;
  return target.C * ((offArcDegrees * Math.PI) / 180) <= ARC_HUE_TOLERANCE;
}

function projectOntoSegment(
  point: [number, number, number],
  pointLab: [number, number, number],
  a: [number, number, number],
  b: [number, number, number]
): { t: number; residual: number } | null {
  const ab: [number, number, number] = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const denom = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2];
  if (denom <= 1e-9) return null;

  const ap: [number, number, number] = [point[0] - a[0], point[1] - a[1], point[2] - a[2]];
  const t = (ap[0] * ab[0] + ap[1] * ab[1] + ap[2] * ab[2]) / denom;
  if (t < 0 || t > 1) return null;

  const projected: [number, number, number] = [
    a[0] + t * ab[0],
    a[1] + t * ab[1],
    a[2] + t * ab[2]
  ];
  const residual = oklabDistance(pointLab, rgbToOklab(projected));
  return { t, residual };
}

/**
 * sRGB (0-255 per channel) to OKLab, per Björn Ottosson's published
 * reference (https://bottosson.github.io/posts/oklab/). L runs 0 (black) to
 * 1 (white); Euclidean distance between two OKLab points is a perceptual
 * color difference, with ~0.02 near the just-noticeable threshold.
 */
export function rgbToOklab(rgb: readonly [number, number, number]): [number, number, number] {
  const r = srgbChannelToLinear(rgb[0]);
  const g = srgbChannelToLinear(rgb[1]);
  const b = srgbChannelToLinear(rgb[2]);

  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);

  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  ];
}

function srgbChannelToLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function oklabDistance(
  left: readonly [number, number, number],
  right: readonly [number, number, number]
): number {
  const dL = left[0] - right[0];
  const da = left[1] - right[1];
  const db = left[2] - right[2];
  return Math.sqrt(dL * dL + da * da + db * db);
}

export type ApplyClassificationResult = {
  nextColors: ClassifyPaletteInput[];
  mixes: MixRecipe[];
  absorbedCount: number;
};

export function applyClassification(
  colors: ClassifyPaletteInput[],
  classifications: ClassifiedColor[]
): ApplyClassificationResult {
  const classificationById = new Map(classifications.map((entry) => [entry.id, entry]));
  const pixelCountById = new Map(colors.map((color) => [color.id, color.pixelCount]));

  let absorbedCount = 0;
  for (const color of colors) {
    const entry = classificationById.get(color.id);
    if (!entry || entry.classification !== "absorb" || !entry.absorbedIntoId) continue;
    const keeperId = entry.absorbedIntoId;
    const keeperPixels = pixelCountById.get(keeperId);
    if (keeperPixels === undefined) {
      throw new Error(`Absorbed color ${color.id} references unknown keeper ${keeperId}.`);
    }
    pixelCountById.set(keeperId, keeperPixels + color.pixelCount);
    pixelCountById.delete(color.id);
    absorbedCount += 1;
  }

  const nextColors: ClassifyPaletteInput[] = [];
  const mixes: MixRecipe[] = [];
  for (const color of colors) {
    const entry = classificationById.get(color.id);
    if (!entry) {
      nextColors.push(color);
      continue;
    }
    if (entry.classification === "absorb") continue;
    const updatedPixelCount = pixelCountById.get(color.id);
    if (updatedPixelCount === undefined) continue;
    nextColors.push({ ...color, pixelCount: updatedPixelCount });
    if (entry.classification === "mix" && entry.recipe) {
      mixes.push(entry.recipe);
    }
  }

  return { nextColors, mixes, absorbedCount };
}

export function applyMixesToCoverage(
  colors: ColorAreaInput[],
  mixes: MixRecipe[]
): ColorAreaInput[] {
  if (mixes.length === 0) return colors.map((color) => ({ ...color }));

  const coverageById = new Map<string, number>();
  for (const color of colors) {
    if (!Number.isFinite(color.coveragePercent) || color.coveragePercent < 0) {
      throw new Error(`Color ${color.id} coveragePercent must be zero or greater.`);
    }
    coverageById.set(color.id, color.coveragePercent);
  }

  const removed = new Set<string>();
  for (const mix of mixes) {
    const targetCoverage = coverageById.get(mix.targetColorId);
    if (targetCoverage === undefined) {
      throw new Error(`Mix target ${mix.targetColorId} is not in the coverage list.`);
    }
    const fractionSum = mix.components.reduce((sum, component) => sum + component.fraction, 0);
    if (Math.abs(fractionSum - 1) > 1e-3) {
      throw new Error(
        `Mix for ${mix.targetColorId} has components summing to ${fractionSum.toFixed(4)}, expected 1.0.`
      );
    }
    for (const component of mix.components) {
      const componentCoverage = coverageById.get(component.colorId);
      if (componentCoverage === undefined) {
        throw new Error(
          `Mix component ${component.colorId} for ${mix.targetColorId} is not in the coverage list.`
        );
      }
      coverageById.set(component.colorId, componentCoverage + component.fraction * targetCoverage);
    }
    removed.add(mix.targetColorId);
  }

  return colors
    .filter((color) => !removed.has(color.id))
    .map((color) => ({ id: color.id, coveragePercent: coverageById.get(color.id)! }));
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}
