import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

export type PaintBrandFinish = {
  id: string;
  display_name: string;
  coverage_multiplier: number;
};

export type PaintBrandPrices = {
  currency: string;
  quart: number;
  gallon: number;
  as_of?: string;
};

export type PaintBrandProfile = {
  id: string;
  display_name: string;
  retailer: string;
  coverage: {
    min: number;
    default: number;
    max: number;
  };
  default_coats: number;
  confidence: string;
  notes: string;
  sources: string[];
  prices: PaintBrandPrices;
  finishes: PaintBrandFinish[];
};

export type PaintBrandCatalog = {
  version: number;
  units: {
    coverage: string;
    price: string;
  };
  brands: PaintBrandProfile[];
};

const currentFile = fileURLToPath(import.meta.url);
const currentDir = path.dirname(currentFile);
const catalogPath = path.resolve(currentDir, "../../../config/paint-brands.yaml");

export async function loadPaintBrandCatalog(): Promise<PaintBrandCatalog> {
  const raw = await readFile(catalogPath, "utf8");
  const parsed = parse(raw) as PaintBrandCatalog;
  validateCatalog(parsed);
  return parsed;
}

export function validateCatalog(catalog: PaintBrandCatalog) {
  if (!catalog?.brands?.length) {
    throw new Error("Paint brand catalog must include at least one brand.");
  }

  for (const brand of catalog.brands) {
    if (!brand.id || !brand.display_name) {
      throw new Error("Each paint brand must have an id and display_name.");
    }

    if (brand.coverage.default < brand.coverage.min || brand.coverage.default > brand.coverage.max) {
      throw new Error(`Coverage defaults must sit within the min/max range for brand ${brand.id}.`);
    }

    if (!brand.prices || !(brand.prices.quart > 0) || !(brand.prices.gallon > 0)) {
      throw new Error(`Brand ${brand.id} must have positive prices.quart and prices.gallon.`);
    }

    if (!brand.finishes?.length) {
      throw new Error(`Brand ${brand.id} must have at least one finish.`);
    }

    const seenFinishIds = new Set<string>();
    for (const finish of brand.finishes) {
      if (!finish.id || !finish.display_name) {
        throw new Error(`Brand ${brand.id} has a finish missing id or display_name.`);
      }
      if (seenFinishIds.has(finish.id)) {
        throw new Error(`Brand ${brand.id} has duplicate finish id: ${finish.id}.`);
      }
      seenFinishIds.add(finish.id);
      if (!(finish.coverage_multiplier > 0)) {
        throw new Error(
          `Brand ${brand.id} finish ${finish.id} must have a positive coverage_multiplier.`
        );
      }
    }
  }
}
