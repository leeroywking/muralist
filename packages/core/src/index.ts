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
  /** Maximum per-channel residual (in 0-255 RGB units) for a color to count as
   * lying on a mixing line. Default 18. Lower = stricter, keeps more buy
   * colors; higher = more aggressive, collapses more onto mixing lines. */
  residualThreshold: number;
  /** Coverage percent threshold that splits mix (kept with recipe, >= threshold)
   * from absorb (silently folded into nearest endpoint, < threshold). */
  mixCoveragePercent: number;
};

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

  const totalPixels = colors.reduce((sum, color) => sum + color.pixelCount, 0);
  if (totalPixels <= 0 || colors.length === 0) {
    return [];
  }

  const coverageById = new Map<string, number>();
  for (const color of colors) {
    coverageById.set(color.id, (color.pixelCount / totalPixels) * 100);
  }

  // Phase 0: near-duplicate dedup. Real-image palettes capture many colors
  // that are geometric neighbors of each other in RGB space without being on
  // a three-point mixing line. The line-fitting algorithm alone misses them.
  // Here we merge any pair whose Euclidean RGB distance falls below the
  // residual threshold — the lower-coverage member absorbs into the
  // higher-coverage one, silently (no mix recipe).
  const dedupResult = dedupNearestNeighbors(colors, options.residualThreshold);
  const survivors = dedupResult.survivors;
  const dedupAbsorbs = dedupResult.absorbs; // id -> keeperId

  if (survivors.length === 0) {
    return colors.map((color) => ({
      id: color.id,
      classification: "absorb",
      absorbedIntoId: dedupAbsorbs.get(color.id) ?? color.id
    }));
  }

  // Phase 1: identify extreme (buy) colors among survivors. A color is
  // extreme if no pair of *other* survivor colors can express it as a
  // segment interpolation within the residual threshold. In a gradient, the
  // two endpoints are extreme and every middle step is interior.
  const extremeIds = new Set<string>();
  for (const candidate of survivors) {
    const others = survivors.filter((color) => color.id !== candidate.id);
    const fit = findBestMixingPair(candidate, others, options.residualThreshold);
    if (!fit) {
      extremeIds.add(candidate.id);
    }
  }

  // Degenerate fallback: if every survivor sits on some mixing line,
  // promote the highest-coverage survivor so we always have at least one buy.
  if (extremeIds.size === 0) {
    let topId: string | null = null;
    let topPixels = -Infinity;
    for (const color of survivors) {
      if (color.pixelCount > topPixels) {
        topPixels = color.pixelCount;
        topId = color.id;
      }
    }
    if (topId) extremeIds.add(topId);
  }

  const extremes = survivors.filter((color) => extremeIds.has(color.id));
  const classifications = new Map<string, ClassifiedColor>();

  // Phase 2: interior survivors classify as mix or absorb based on coverage.
  // Recompute coverage using the *absorbed* pixel counts so dedup-absorbed
  // members contribute to their keeper's mix-threshold check.
  const adjustedPixelsById = new Map<string, number>();
  for (const survivor of survivors) {
    adjustedPixelsById.set(survivor.id, survivor.pixelCount);
  }
  for (const [absorbedId, keeperId] of dedupAbsorbs.entries()) {
    const absorbed = colors.find((color) => color.id === absorbedId);
    if (!absorbed) continue;
    const current = adjustedPixelsById.get(keeperId) ?? 0;
    adjustedPixelsById.set(keeperId, current + absorbed.pixelCount);
  }
  const adjustedCoverageById = new Map<string, number>();
  let adjustedTotal = 0;
  for (const value of adjustedPixelsById.values()) adjustedTotal += value;
  if (adjustedTotal > 0) {
    for (const [id, pixels] of adjustedPixelsById.entries()) {
      adjustedCoverageById.set(id, (pixels / adjustedTotal) * 100);
    }
  }

  for (const color of survivors) {
    if (extremeIds.has(color.id)) {
      classifications.set(color.id, { id: color.id, classification: "buy" });
      continue;
    }

    const fit = findBestMixingPair(color, extremes, options.residualThreshold);
    if (!fit) {
      classifications.set(color.id, { id: color.id, classification: "buy" });
      continue;
    }

    const coverage = adjustedCoverageById.get(color.id) ?? coverageById.get(color.id) ?? 0;
    const { endpointA, endpointB, t } = fit;

    if (coverage >= options.mixCoveragePercent) {
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
        absorbedIntoId: t < 0.5 ? endpointA.id : endpointB.id
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

  return colors.map((color) => classifications.get(color.id)!);
}

function dedupNearestNeighbors(
  colors: ClassifyPaletteInput[],
  threshold: number
): { survivors: ClassifyPaletteInput[]; absorbs: Map<string, string> } {
  const survivors: ClassifyPaletteInput[] = colors.map((color) => ({ ...color }));
  const absorbs = new Map<string, string>();

  // Repeated nearest-pair merge. Each pass picks the tightest pair; the
  // lower-pixelCount member absorbs into the higher-pixelCount one. Bounded
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
        const dx = a.rgb[0] - b.rgb[0];
        const dy = a.rgb[1] - b.rgb[1];
        const dz = a.rgb[2] - b.rgb[2];
        const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (distance >= threshold) continue;
        if (distance < bestDistance) {
          bestDistance = distance;
          // Keeper = the one with more pixels, or lexicographically smaller
          // id on ties for deterministic test output.
          if (
            a.pixelCount > b.pixelCount ||
            (a.pixelCount === b.pixelCount && a.id.localeCompare(b.id) <= 0)
          ) {
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
    // Also redirect any prior absorbers that pointed at `absorbed`.
    for (const [id, target] of absorbs.entries()) {
      if (target === absorbed.id) absorbs.set(id, finalKeeperId);
    }

    keeper.pixelCount += absorbed.pixelCount;
    survivors.splice(absorbedIndex, 1);
  }

  return { survivors, absorbs };
}

function findBestMixingPair(
  candidate: ClassifyPaletteInput,
  buyColors: ClassifyPaletteInput[],
  residualThreshold: number
): { endpointA: ClassifyPaletteInput; endpointB: ClassifyPaletteInput; t: number; residual: number } | null {
  if (buyColors.length < 2) return null;

  let best: {
    endpointA: ClassifyPaletteInput;
    endpointB: ClassifyPaletteInput;
    t: number;
    residual: number;
    combinedPixelCount: number;
  } | null = null;

  for (let i = 0; i < buyColors.length; i += 1) {
    for (let j = i + 1; j < buyColors.length; j += 1) {
      const a = buyColors[i]!;
      const b = buyColors[j]!;
      const fit = projectOntoSegment(candidate.rgb, a.rgb, b.rgb);
      if (fit === null) continue;
      if (fit.residual > residualThreshold) continue;

      const combinedPixelCount = a.pixelCount + b.pixelCount;
      if (
        !best ||
        fit.residual < best.residual - 1e-6 ||
        (Math.abs(fit.residual - best.residual) < 1e-6 &&
          combinedPixelCount > best.combinedPixelCount)
      ) {
        best = { endpointA: a, endpointB: b, t: fit.t, residual: fit.residual, combinedPixelCount };
      }
    }
  }

  if (!best) return null;
  return {
    endpointA: best.endpointA,
    endpointB: best.endpointB,
    t: best.t,
    residual: best.residual
  };
}

function projectOntoSegment(
  point: [number, number, number],
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
  const dx = point[0] - projected[0];
  const dy = point[1] - projected[1];
  const dz = point[2] - projected[2];
  const residual = Math.sqrt(dx * dx + dy * dy + dz * dz);
  return { t, residual };
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
