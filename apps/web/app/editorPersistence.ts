// Glue between the editor (PrototypeApp) and the backend project API.
//
// This module is intentionally I/O-light: it exposes pure builders that
// translate the editor's in-memory palette state into the shape the backend
// expects (and back), plus a thin `getUploadLimits()` helper that falls back
// to hard-coded defaults because the backend does not (yet) expose an
// `/api/upload-limits` endpoint — flagged in docs/plans/web-ui-post-backend.md
// §1 step 10.
//
// Keeping these transforms pure makes the cloud save / load paths testable
// without a browser. `PrototypeApp.tsx` imports the helpers; all DOM /
// network orchestration lives in the component.
//
// Relevant references:
//   - apps/web/app/apiClient.ts      — typed endpoint wrappers.
//   - apps/web/app/uploadPipeline.ts — sanitizeUpload + blobToBase64.
//   - apps/api/src/schemas/project.ts — zod schema the payloads must satisfy.

import type { MixRecipe, PaletteClassification } from "@muralist/core";
import type { UploadLimits } from "@muralist/config";

import type {
  CreateProjectPayload,
  PaletteColor as BackendPaletteColor,
  PaletteJson,
  ProjectFull
} from "./apiClient";

// ---------------------------------------------------------------------------
// Upload limits
// ---------------------------------------------------------------------------

// Keep in sync with config/upload-limits.yaml. Surfaced here because the
// static-exported web app has no authoritative runtime source: the backend
// validates pass-through but does not expose the caps. When a GET
// `/api/upload-limits` endpoint lands, switch `getUploadLimits()` to fetch
// from it and keep these as the offline fallback.
export const DEFAULT_UPLOAD_LIMITS: UploadLimits = {
  version: 1,
  sanitizedImage: { maxBytes: 204800, longEdge: 640, jpegQuality: 0.8 },
  thumbnail: { maxBytes: 24576, longEdge: 192, jpegQuality: 0.8 },
  contentTypeAllowlist: ["image/jpeg", "image/webp"]
};

/**
 * Returns the configured upload limits. Currently returns defaults
 * synchronously because there is no backend endpoint — see module header.
 * Typed async so a future fetch-based implementation doesn't force call-site
 * churn.
 */
export async function getUploadLimits(): Promise<UploadLimits> {
  return DEFAULT_UPLOAD_LIMITS;
}

// ---------------------------------------------------------------------------
// Editor ↔ backend palette shape
// ---------------------------------------------------------------------------

/**
 * The in-memory palette chip the editor works with. Kept as a local type so
 * the helper module doesn't need to import from `PrototypeApp.tsx` (which
 * would pull the whole client tree into the test bundle).
 */
export type EditorPaletteColor = {
  id: string;
  hex: string;
  rgb: [number, number, number];
  pixelCount: number;
  coveragePercent: number;
};

export type EditorSnapshot = {
  paletteColors: EditorPaletteColor[];
  originalPaletteColors?: EditorPaletteColor[];
  classifications: Record<string, PaletteClassification>;
  mixRecipes: MixRecipe[];
  colorFinishOverrides: Record<string, string>;
  colorCoatsOverrides: Record<string, number>;
};

/**
 * Convert the editor's `coveragePercent` (0-100) into the backend's
 * `coverage` (0-1), and renormalise so the sum lands within the server's
 * ±0.01 epsilon even if per-chip rounding drifted a little.
 */
export function toBackendPaletteColors(
  colors: EditorPaletteColor[],
  classifications: Record<string, PaletteClassification> = {}
): BackendPaletteColor[] {
  if (colors.length === 0) return [];
  const rawCoverages = colors.map((c) => Math.max(0, c.coveragePercent / 100));
  const rawSum = rawCoverages.reduce((acc, v) => acc + v, 0);
  // Renormalise when the editor's percents drift. If the sum is zero (all
  // chips report 0%), distribute evenly so the payload still validates.
  const normalisedCoverages = rawSum > 0
    ? rawCoverages.map((v) => v / rawSum)
    : rawCoverages.map(() => 1 / colors.length);
  return colors.map((color, index) => {
    const classification = classifications[color.id];
    const backendColor: BackendPaletteColor = {
      id: color.id,
      hex: color.hex.toUpperCase().slice(0, 7),
      coverage: normalisedCoverages[index]!
    };
    if (classification) {
      backendColor.classification = classification;
    }
    return backendColor;
  });
}

/**
 * Serialise the editor state into the `palette` JSON the backend schema
 * (see `apps/api/src/schemas/project.ts`) accepts. The merge-reversibility
 * story in docs/plans/web-ui-post-backend.md §2.1 is satisfied by surfacing
 * `originalColors` alongside the current working set; the `merges[]` log is
 * left empty for this round because the editor currently does not track
 * merge operations as structured events (manual merges mutate palette state
 * directly; auto-combine produces `mixRecipes`).
 */
export function buildPaletteJson(snapshot: EditorSnapshot): PaletteJson {
  const palette: PaletteJson = {
    colors: toBackendPaletteColors(
      snapshot.paletteColors,
      snapshot.classifications
    )
  };
  if (snapshot.originalPaletteColors && snapshot.originalPaletteColors.length > 0) {
    palette.originalColors = toBackendPaletteColors(snapshot.originalPaletteColors);
  }
  if (snapshot.mixRecipes.length > 0) {
    // The backend's mix recipe shape matches `@muralist/core`'s shape 1:1
    // (targetColorId + components[{ colorId, fraction }]); preserve directly.
    palette.mixRecipes = snapshot.mixRecipes;
  }
  if (Object.keys(snapshot.colorFinishOverrides).length > 0) {
    palette.finishOverrides = { ...snapshot.colorFinishOverrides };
  }
  if (Object.keys(snapshot.colorCoatsOverrides).length > 0) {
    // Backend expects int 1-10; coerce defensively.
    const coats: Record<string, number> = {};
    for (const [id, value] of Object.entries(snapshot.colorCoatsOverrides)) {
      const rounded = Math.max(1, Math.min(10, Math.round(value)));
      coats[id] = rounded;
    }
    palette.coatsOverrides = coats;
  }
  return palette;
}

export type BuildCreateProjectArgs = {
  name: string;
  snapshot: EditorSnapshot;
  sanitizedImageBase64: string;
  thumbnailBase64: string;
};

/**
 * Assemble the `POST /projects` body. Separated from `buildPaletteJson` so
 * tests can assert the outer envelope (name / image / thumbnail) and the
 * palette JSON independently.
 */
export function buildCreateProjectPayload(
  args: BuildCreateProjectArgs
): CreateProjectPayload {
  return {
    name: args.name,
    palette: buildPaletteJson(args.snapshot),
    image: args.sanitizedImageBase64,
    thumbnail: args.thumbnailBase64
  };
}

// ---------------------------------------------------------------------------
// Backend → editor hydration
// ---------------------------------------------------------------------------

export type HydratedEditorState = {
  paletteColors: EditorPaletteColor[];
  originalPaletteColors: EditorPaletteColor[];
  classifications: Record<string, PaletteClassification>;
  mixRecipes: MixRecipe[];
  colorFinishOverrides: Record<string, string>;
  colorCoatsOverrides: Record<string, number>;
  /** Base64-decoded data URL suitable for an <img src>. */
  imageDataUrl: string;
  version: number;
  projectId: string;
  name: string;
};

function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace(/^#/, "");
  if (clean.length !== 6) return [0, 0, 0];
  const r = Number.parseInt(clean.slice(0, 2), 16);
  const g = Number.parseInt(clean.slice(2, 4), 16);
  const b = Number.parseInt(clean.slice(4, 6), 16);
  return [
    Number.isFinite(r) ? r : 0,
    Number.isFinite(g) ? g : 0,
    Number.isFinite(b) ? b : 0
  ];
}

function toEditorPaletteColors(
  backendColors: BackendPaletteColor[] | undefined
): EditorPaletteColor[] {
  if (!backendColors) return [];
  // pixelCount is not persisted — derive a proxy from coverage so downstream
  // maths (e.g. auto-combine, merge rebalancing) still have a weight. The
  // exact scale is irrelevant; only ratios matter.
  const SCALE = 100000;
  return backendColors.map((color) => ({
    id: color.id,
    hex: color.hex.toUpperCase(),
    rgb: hexToRgb(color.hex),
    pixelCount: Math.max(1, Math.round(color.coverage * SCALE)),
    coveragePercent: color.coverage * 100
  }));
}

function toEditorClassifications(
  backendColors: BackendPaletteColor[] | undefined
): Record<string, PaletteClassification> {
  if (!backendColors) return {};
  const out: Record<string, PaletteClassification> = {};
  for (const color of backendColors) {
    if (color.classification) {
      out[color.id] = color.classification;
    }
  }
  return out;
}

/**
 * Project payload → editor-ready state. The image blob arrives as raw
 * base64 (no data URL prefix) per the backend contract; we wrap it as a
 * `data:image/jpeg;base64,...` URL because that's what the editor's `<img>`
 * preview expects. The sanitizer always emits JPEG, so the mime type is
 * safe.
 */
export function hydrateFromProject(project: ProjectFull): HydratedEditorState {
  const palette = project.palette ?? { colors: [] };
  const mixRecipes = Array.isArray(palette.mixRecipes)
    ? (palette.mixRecipes as MixRecipe[])
    : [];
  return {
    paletteColors: toEditorPaletteColors(palette.colors),
    originalPaletteColors: toEditorPaletteColors(palette.originalColors),
    classifications: toEditorClassifications(palette.colors),
    mixRecipes,
    colorFinishOverrides: { ...(palette.finishOverrides ?? {}) },
    colorCoatsOverrides: { ...(palette.coatsOverrides ?? {}) },
    imageDataUrl: `data:image/jpeg;base64,${project.sanitizedImage}`,
    version: project.version,
    projectId: project.id,
    name: project.name
  };
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/** Strip a file extension for use as a default project name. */
export function stripExtension(fileName: string): string {
  if (!fileName) return "Untitled project";
  const dot = fileName.lastIndexOf(".");
  if (dot <= 0) return fileName;
  return fileName.slice(0, dot);
}

/**
 * Parse `?project=<id>` out of a `location.search` string (including the
 * leading `?`). Returns `null` when absent or empty. Extracted so the
 * component can call it inside `useEffect` without depending on Next's
 * `useSearchParams` (which forces a Suspense boundary).
 */
export function readProjectIdFromSearch(search: string): string | null {
  if (!search || search.length === 0) return null;
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const id = params.get("project");
  return id && id.length > 0 ? id : null;
}
