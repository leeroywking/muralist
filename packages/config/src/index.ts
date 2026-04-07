import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

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
};

export type PaintBrandCatalog = {
  version: number;
  units: {
    coverage: string;
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

function validateCatalog(catalog: PaintBrandCatalog) {
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
  }
}

