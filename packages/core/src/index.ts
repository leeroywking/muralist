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

export type ColorAreaEstimate = {
  id: string;
  coveragePercent: number;
  areaSqFt: number;
};

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
