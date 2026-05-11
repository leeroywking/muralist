"use client";

import { ChangeEvent, useEffect, useMemo, useRef, useState, useTransition } from "react";
import type { PaintBrandCatalog } from "@muralist/config";
import type {
  AspectRatioReport,
  ColorContainerPlan,
  ContainerPlan,
  ContainerPlanEntry,
  GridSpec,
  MixRecipe,
  PaletteClassification,
  WorkspaceContent
} from "@muralist/core";
import {
  applyClassification,
  applyMixesToCoverage,
  buildMaquetteFileName,
  classifyPaletteColors,
  compareAspectRatios,
  deriveColorAreaEstimates,
  deriveGridSpec,
  suggestContainersForColors
} from "@muralist/core";
import { downloadMaquettePdf } from "./maquettePdf";
import {
  OverLimitError,
  UnauthenticatedError,
  VersionConflictError,
  createProject,
  getMe,
  getProject,
  markViewed,
  updatePalette,
  updateProSettings,
  type Me
} from "./apiClient";
import {
  buildCreateProjectPayload,
  buildPaletteJson,
  getUploadLimits,
  hydrateFromProject,
  readProjectIdFromSearch,
  stripExtension,
  type EditorSnapshot
} from "./editorPersistence";
import { blobToBase64, sanitizeUpload, UploadSanitizationError } from "./uploadPipeline";
import type { UploadLimits } from "@muralist/config";

type PaletteColor = {
  id: string;
  hex: string;
  rgb: [number, number, number];
  pixelCount: number;
  coveragePercent: number;
  /**
   * When true, the color is skipped from the estimate, container plan,
   * maquette PDF swatch table, and Auto-combine classifier input. Its
   * assigned pixels in the flatten preview render as a diagonal-stripe
   * hatch instead of the color itself. The color stays in `paletteColors`
   * so the user can re-enable it.
   */
  disabled?: boolean;
  /**
   * When true, the color is protected from Auto-combine absorbing it.
   * Other unlocked colors can still absorb INTO a locked color. Pulled
   * colors (extracted via art-tap) are always locked by default.
   */
  locked?: boolean;
};

type AnalysisResult = {
  width: number;
  height: number;
  colors: PaletteColor[];
};

export type FieldSheetColor = {
  colorId: string;
  hex: string;
  coveragePercent: number;
  areaSqFt: number;
  finishLabel: string;
  coats: number;
  packageLabel: string;
  requiredGallons: number;
  estimatedCost: number;
};

export type FieldSheetColorWithClassification = FieldSheetColor & {
  classification: PaletteClassification;
  recipe?: MixRecipe;
};

export type FieldSheetModel = {
  fileName: string;
  artistNotes: string;
  sourceSize: { widthPx: number; heightPx: number };
  wall: { widthFt: number; heightFt: number; areaSqFt: number };
  grid: GridSpec;
  aspectRatio: AspectRatioReport;
  brandLabel: string;
  retailer: string;
  currency: string;
  colors: FieldSheetColorWithClassification[];
  workspace: WorkspaceContent;
  totals: {
    packageLabel: string;
    requiredGallons: number;
    estimatedCost: number;
  };
};

type SavedMergePlan = {
  savedAt: string;
  fileName: string;
  selectedBrandId: string;
  wallLength: string;
  wallWidth: string;
  gridCellSize: string;
  artistNotes?: string;
  coats: string;
  wastePercent: string;
  sourceAnalysis: AnalysisResult | null;
  paletteColors: PaletteColor[];
  defaultFinishId?: string;
  colorFinishOverrides?: Record<string, string>;
  colorCoatsOverrides?: Record<string, number>;
  classifications?: Record<string, PaletteClassification>;
  mixRecipes?: MixRecipe[];
};

type AutoCombineSensitivity = "conservative" | "balanced" | "aggressive" | "custom";

type ProSettings = {
  autoCombineSensitivity: AutoCombineSensitivity;
  residualThreshold: number;
  mixCoveragePercent: number;
  rememberOnDevice: boolean;
};

// Calibrated against the 12-per-channel quantization applied in
// analyzeLoadedImage. The minimum inter-cluster Euclidean distance is
// sqrt(3) * 12 ≈ 20.8, so any threshold near that is effectively inert.
// Presets sit above the quantization floor to give meaningful behavior on
// real captured palettes.
const SENSITIVITY_PRESETS: Record<Exclude<AutoCombineSensitivity, "custom">, number> = {
  conservative: 24,
  balanced: 36,
  aggressive: 54
};

const DEFAULT_PRO_SETTINGS: ProSettings = {
  autoCombineSensitivity: "balanced",
  residualThreshold: SENSITIVITY_PRESETS.balanced,
  mixCoveragePercent: 5,
  rememberOnDevice: true
};

// The flatten-to-palette visualization runs on a downsampled canvas to keep
// per-frame painter cost bounded — it does NOT affect the swatch survey,
// which runs at full natural resolution on the original upload.
const flattenVizMaxDimension = 320;
// Stride controller for the swatch survey. At ≥500k samples, a 7-megapixel
// phone photo runs with stride ≈14, which keeps small accent regions well
// represented while bounding the loop cost.
const maxSamplePixels = 500_000;
const savedMergePlanKey = "muralist.saved-merge-plan";
const proSettingsKey = "muralist.pro-settings";

type PrototypeAppProps = {
  catalog: PaintBrandCatalog;
};

export function PrototypeApp({ catalog }: PrototypeAppProps) {
  const defaultBrand = catalog.brands[0]!;
  const defaultFinishForBrand = (brandId: string) => {
    const brand = catalog.brands.find((entry) => entry.id === brandId) ?? defaultBrand;
    return brand.finishes[0]!.id;
  };

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const sourcePixelsRef = useRef<{ data: Uint8ClampedArray; width: number; height: number } | null>(null);
  // Raw bucket list from the upload-time survey, kept so the user's
  // proactive/reactive art-tap can resolve a tapped pixel back to a cluster
  // and pull it out as a locked palette member. Survives Auto-combine
  // re-runs at different sensitivities — this is the immutable source of
  // truth for "what colors were originally in the artwork."
  const originalClustersRef = useRef<PaletteColor[] | null>(null);
  // The classifier options that produced the current visible palette, used
  // when re-running the classifier on art-tap or unlock so the redistribute
  // step uses the same options as the last Auto-combine pass.
  const [lastClassifiedOptions, setLastClassifiedOptions] = useState<{
    residualThreshold: number;
    mixCoveragePercent: number;
  } | null>(null);
  // Most-recently pulled color id, used to drive a brief highlight pulse on
  // the matching swatch card after an art-tap.
  const [recentlyPulledId, setRecentlyPulledId] = useState<string | null>(null);
  // `proSettingsHydratedRef` flips to true once /me has populated proSettings
  // so the save-back effect doesn't PATCH the default values before the real
  // server values arrive. `proSettingsSkipNextPushRef` suppresses the PATCH
  // that would otherwise fire on the setState triggered by hydration itself.
  const proSettingsHydratedRef = useRef(false);
  const proSettingsSkipNextPushRef = useRef(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [flattenedImageUrl, setFlattenedImageUrl] = useState<string | null>(null);
  const [fileName, setFileName] = useState("");
  const [sourceAnalysis, setSourceAnalysis] = useState<AnalysisResult | null>(null);
  const [paletteColors, setPaletteColors] = useState<PaletteColor[]>([]);
  const [selectedBrandId, setSelectedBrandId] = useState(defaultBrand.id);
  const [wallLength, setWallLength] = useState("25");
  const [wallWidth, setWallWidth] = useState("10");
  const [gridCellSize, setGridCellSize] = useState("2");
  const [artistNotes, setArtistNotes] = useState("");
  const [coats, setCoats] = useState(String(defaultBrand.default_coats));
  const [wastePercent, setWastePercent] = useState("10");
  const [defaultFinishId, setDefaultFinishId] = useState<string>(defaultBrand.finishes[0]!.id);
  const [colorFinishOverrides, setColorFinishOverrides] = useState<Record<string, string>>({});
  const [colorCoatsOverrides, setColorCoatsOverrides] = useState<Record<string, number>>({});
  const [selectedColorIds, setSelectedColorIds] = useState<string[]>([]);
  const [mergeKeeperId, setMergeKeeperId] = useState<string>("");
  const [savedMergePlan, setSavedMergePlan] = useState<SavedMergePlan | null>(null);
  const [saveMessage, setSaveMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [isGeneratingPdf, setIsGeneratingPdf] = useState(false);
  const [pdfError, setPdfError] = useState<string | null>(null);
  const [classifications, setClassifications] = useState<Record<string, PaletteClassification>>({});
  const [mixRecipes, setMixRecipes] = useState<MixRecipe[]>([]);
  const [showProSettings, setShowProSettings] = useState(false);
  const [proSettings, setProSettings] = useState<ProSettings>(DEFAULT_PRO_SETTINGS);

  // --- Cloud save / load state --------------------------------------------
  // The editor stays fully functional for guests; these state slots only
  // light up when the user is signed in (per docs/plans/web-ui-post-backend.md
  // §1 step 8 — guest flow must keep working unchanged).
  const [isSignedIn, setIsSignedIn] = useState<boolean | null>(null);
  const [uploadLimits, setUploadLimits] = useState<UploadLimits | null>(null);
  const [sanitizedImageBase64, setSanitizedImageBase64] = useState<string | null>(null);
  const [thumbnailBase64, setThumbnailBase64] = useState<string | null>(null);
  // `cloudMode` tracks which save UI to show:
  //   "idle"   — no palette to save yet (or guest without palette).
  //   "new"    — signed-in with a palette from upload; button says "Save to my account".
  //   "loaded" — palette came from `?project=<id>`; button says "Save changes".
  const [cloudMode, setCloudMode] = useState<"idle" | "new" | "loaded">("idle");
  const [loadedProjectId, setLoadedProjectId] = useState<string | null>(null);
  const [loadedProjectVersion, setLoadedProjectVersion] = useState<number | null>(null);
  const [projectName, setProjectName] = useState<string>("");
  const [cloudSaveStatus, setCloudSaveStatus] = useState<string | null>(null);
  const [cloudSaveError, setCloudSaveError] = useState<string | null>(null);
  const [versionConflict, setVersionConflict] = useState(false);
  const [projectLoadError, setProjectLoadError] = useState<string | null>(null);

  const selectedBrand =
    catalog.brands.find((brand) => brand.id === selectedBrandId) ?? defaultBrand;
  const parsedLength = Number(wallLength);
  const parsedWidth = Number(wallWidth);
  const parsedGridCellSize = Number(gridCellSize);
  const parsedCoats = Number(coats);
  const parsedWaste = Number(wastePercent) / 100;
  const wallArea = parsedLength * parsedWidth;

  const estimateReady =
    paletteColors.length > 0 &&
    Number.isFinite(parsedLength) &&
    parsedLength > 0 &&
    Number.isFinite(parsedWidth) &&
    parsedWidth > 0 &&
    Number.isFinite(parsedGridCellSize) &&
    parsedGridCellSize > 0 &&
    Number.isFinite(parsedCoats) &&
    parsedCoats > 0 &&
    Number.isFinite(parsedWaste) &&
    parsedWaste >= 0;

  const adjustedCoverage = useMemo(() => {
    // Disabled colors are excluded entirely. Coverage values are NOT
    // renormalized — the remaining colors keep their original percentages
    // and the painted-area sum naturally drops below 100% (correct when
    // the disabled colors represent bare wall / unpainted areas).
    const raw = paletteColors
      .filter((color) => !color.disabled)
      .map((color) => ({
        id: color.id,
        coveragePercent: color.coveragePercent
      }));
    if (mixRecipes.length === 0) return raw;
    try {
      return applyMixesToCoverage(raw, mixRecipes);
    } catch {
      // Mix recipes reference ids that are no longer in the palette (e.g. a
      // manual merge ran after auto-combine). Fall back to raw coverage —
      // the next auto-combine pass will re-derive.
      return raw;
    }
  }, [paletteColors, mixRecipes]);

  const containerPlan: ContainerPlan | null = useMemo(() => {
    if (!estimateReady) {
      return null;
    }
    return suggestContainersForColors(
      {
        brandId: selectedBrandId,
        areaSqFt: wallArea,
        coats: parsedCoats,
        wasteFactor: parsedWaste,
        defaultFinishId,
        colors: adjustedCoverage.map((color) => ({
          id: color.id,
          coveragePercent: color.coveragePercent,
          finishId: colorFinishOverrides[color.id],
          coats: colorCoatsOverrides[color.id]
        }))
      },
      catalog
    );
  }, [
    catalog,
    selectedBrandId,
    wallArea,
    parsedCoats,
    parsedWaste,
    defaultFinishId,
    colorFinishOverrides,
    colorCoatsOverrides,
    adjustedCoverage,
    estimateReady
  ]);

  const fieldSheetModel: FieldSheetModel | null = useMemo(() => {
    if (!estimateReady || !sourceAnalysis || !containerPlan) {
      return null;
    }

    const grid = deriveGridSpec(
      { widthFt: parsedLength, heightFt: parsedWidth },
      parsedGridCellSize
    );
    const aspectRatio = compareAspectRatios(
      { widthPx: sourceAnalysis.width, heightPx: sourceAnalysis.height },
      { widthFt: parsedLength, heightFt: parsedWidth }
    );
    // Disabled colors don't appear in the field sheet — they're omitted
    // from the swatch table and excluded from totals.
    const enabledColors = paletteColors.filter((color) => !color.disabled);
    const colorAreas = deriveColorAreaEstimates(
      wallArea,
      enabledColors.map((color) => ({
        id: color.id,
        coveragePercent: color.coveragePercent
      }))
    );
    const areaByColorId = new Map(colorAreas.map((color) => [color.id, color.areaSqFt]));
    const totalRequiredGallons = containerPlan.perColor.reduce(
      (sum, entry) => sum + entry.requiredGallons,
      0
    );

    const recipeByTargetId = new Map(mixRecipes.map((recipe) => [recipe.targetColorId, recipe]));

    return {
      fileName,
      artistNotes,
      sourceSize: { widthPx: sourceAnalysis.width, heightPx: sourceAnalysis.height },
      wall: { widthFt: parsedLength, heightFt: parsedWidth, areaSqFt: wallArea },
      grid,
      aspectRatio,
      brandLabel: selectedBrand.display_name,
      retailer: selectedBrand.retailer,
      currency: containerPlan.currency,
      colors: enabledColors.map((color) => {
        const plan = containerPlan.perColor.find((entry) => entry.colorId === color.id);
        const finish = selectedBrand.finishes.find((entry) => entry.id === plan?.finishId);
        const classification: PaletteClassification = classifications[color.id] ?? "buy";
        const recipe = recipeByTargetId.get(color.id);
        return {
          colorId: color.id,
          hex: color.hex,
          coveragePercent: color.coveragePercent,
          areaSqFt: areaByColorId.get(color.id) ?? 0,
          finishLabel: finish?.display_name ?? plan?.finishId ?? defaultFinishId,
          coats: plan?.coats ?? parsedCoats,
          packageLabel: plan ? plan.packages.map(formatContainerEntry).join(" + ") : "mix",
          requiredGallons: plan?.requiredGallons ?? 0,
          estimatedCost: plan?.estimatedCost ?? 0,
          classification,
          recipe
        };
      }),
      workspace:
        mixRecipes.length > 0
          ? { kind: "mixes", mixes: mixRecipes }
          : { kind: "blank" },
      totals: {
        packageLabel: formatContainerTotals(containerPlan.totals),
        requiredGallons: totalRequiredGallons,
        estimatedCost: containerPlan.totals.estimatedCost
      }
    };
  }, [
    containerPlan,
    defaultFinishId,
    estimateReady,
    fileName,
    artistNotes,
    paletteColors,
    classifications,
    mixRecipes,
    parsedCoats,
    parsedGridCellSize,
    parsedLength,
    parsedWidth,
    selectedBrand,
    sourceAnalysis,
    wallArea
  ]);

  useEffect(() => {
    if (!recentlyPulledId) return;
    if (typeof window === "undefined") return;
    const timer = window.setTimeout(() => setRecentlyPulledId(null), 1500);
    return () => window.clearTimeout(timer);
  }, [recentlyPulledId]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const source = sourcePixelsRef.current;
    if (!source || paletteColors.length === 0) {
      setFlattenedImageUrl(null);
      return;
    }
    let cancelled = false;
    const compute = () => {
      const flat = flattenImageToPalette(source, paletteColors);
      if (!cancelled) {
        setFlattenedImageUrl(flat);
      }
    };
    const idleId = (window as unknown as { requestIdleCallback?: (cb: () => void) => number }).requestIdleCallback;
    if (typeof idleId === "function") {
      const handle = idleId(compute);
      return () => {
        cancelled = true;
        const cancelIdle = (window as unknown as { cancelIdleCallback?: (h: number) => void }).cancelIdleCallback;
        if (typeof cancelIdle === "function") cancelIdle(handle);
      };
    }
    const timeoutId = window.setTimeout(compute, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [paletteColors]);

  const planByColorId = useMemo(() => {
    const map = new Map<string, ColorContainerPlan>();
    if (containerPlan) {
      for (const entry of containerPlan.perColor) {
        map.set(entry.colorId, entry);
      }
    }
    return map;
  }, [containerPlan]);

  const mergeOptions = useMemo(() => {
    return paletteColors.filter((color) => selectedColorIds.includes(color.id));
  }, [paletteColors, selectedColorIds]);

  // Local-only persistence (savedMergePlan + proSettings) only runs while
  // the user is signed OUT. For signed-in users the server is the source of
  // truth — proSettings hydrate from /me below and save back via
  // PATCH /me/pro-settings, and the "save merged choices on this device"
  // button is hidden in favor of "Save to my account". Running both paths
  // at once lets localStorage silently override server state.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (isSignedIn !== false) return;

    const saved = window.localStorage.getItem(savedMergePlanKey);
    if (!saved) return;
    try {
      const parsed = JSON.parse(saved) as SavedMergePlan;
      setSavedMergePlan(parsed);
    } catch {
      window.localStorage.removeItem(savedMergePlanKey);
    }
  }, [isSignedIn]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (isSignedIn !== false) return;

    const saved = window.localStorage.getItem(proSettingsKey);
    if (!saved) return;
    try {
      const parsed = JSON.parse(saved) as Partial<ProSettings>;
      setProSettings({ ...DEFAULT_PRO_SETTINGS, ...parsed });
    } catch {
      window.localStorage.removeItem(proSettingsKey);
    }
  }, [isSignedIn]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (isSignedIn !== false) return;

    if (proSettings.rememberOnDevice) {
      window.localStorage.setItem(proSettingsKey, JSON.stringify(proSettings));
    } else {
      window.localStorage.removeItem(proSettingsKey);
    }
  }, [proSettings, isSignedIn]);

  // Fetch upload limits once. If the (not-yet-built) /api/upload-limits
  // endpoint goes live, swap `getUploadLimits` to hit it — the fallback
  // defaults stay correct for config/upload-limits.yaml in the meantime.
  useEffect(() => {
    let cancelled = false;
    getUploadLimits()
      .then((limits) => {
        if (!cancelled) setUploadLimits(limits);
      })
      .catch(() => {
        if (!cancelled) setUploadLimits(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Detect whether the user is signed in. On 401 we stay in guest mode with
  // the full local-only flow; on success the "Save to my account" affordance
  // lights up and proSettings hydrate from the server.
  useEffect(() => {
    let cancelled = false;
    getMe()
      .then((me: Me) => {
        if (cancelled) return;
        setIsSignedIn(true);
        // Server proSettings are the source of truth for signed-in users.
        // Merge onto DEFAULT_PRO_SETTINGS so any field the server hasn't
        // saved yet (e.g. rememberOnDevice, which is device-only) keeps its
        // default instead of going undefined.
        proSettingsSkipNextPushRef.current = true;
        setProSettings((current) => ({
          ...DEFAULT_PRO_SETTINGS,
          ...current,
          ...(me.proSettings ?? {})
        }));
        proSettingsHydratedRef.current = true;
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof UnauthenticatedError) {
          setIsSignedIn(false);
        } else {
          // Network blip — treat as signed-out so the guest path still works.
          setIsSignedIn(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Push proSettings changes back to the server for signed-in users. Runs
  // AFTER /me hydration (gated by proSettingsHydratedRef) so the initial
  // setProSettings from /me doesn't trigger a redundant PATCH.
  useEffect(() => {
    if (isSignedIn !== true) return;
    if (!proSettingsHydratedRef.current) return;
    if (proSettingsSkipNextPushRef.current) {
      proSettingsSkipNextPushRef.current = false;
      return;
    }
    const controller = new AbortController();
    updateProSettings({
      autoCombineSensitivity: proSettings.autoCombineSensitivity,
      residualThreshold: proSettings.residualThreshold,
      mixCoveragePercent: proSettings.mixCoveragePercent
    }).catch((err) => {
      if (controller.signal.aborted) return;
      // Don't surface transient save errors to the user — the next change
      // will try again, and the local state stays correct in the meantime.
      // eslint-disable-next-line no-console
      console.warn("updateProSettings failed", err);
    });
    return () => controller.abort();
  }, [
    proSettings.autoCombineSensitivity,
    proSettings.residualThreshold,
    proSettings.mixCoveragePercent,
    isSignedIn
  ]);

  // If the URL carries `?project=<id>` AND the user is signed in, hydrate
  // the editor from the backend. Runs once per (auth, id) tuple.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (isSignedIn !== true) return;
    const projectId = readProjectIdFromSearch(window.location.search);
    if (!projectId) return;
    let cancelled = false;
    setProjectLoadError(null);
    (async () => {
      try {
        const project = await getProject(projectId);
        if (cancelled) return;
        const hydrated = hydrateFromProject(project);
        setPaletteColors(hydrated.paletteColors);
        setClassifications(hydrated.classifications);
        setMixRecipes(hydrated.mixRecipes);
        setColorFinishOverrides(hydrated.colorFinishOverrides);
        setColorCoatsOverrides(hydrated.colorCoatsOverrides);
        setPreviewUrl(hydrated.imageDataUrl);
        setFlattenedImageUrl(null);
        sourcePixelsRef.current = null;
        // Restore the raw cluster set (for art-tap / pull-color) if the
        // project was saved with it. Empty array for pre-feature projects
        // — art-tap will no-op silently in that case.
        originalClustersRef.current = hydrated.originalPaletteColors.length > 0
          ? hydrated.originalPaletteColors.map((color) => ({ ...color }))
          : null;
        setLastClassifiedOptions({
          residualThreshold: SENSITIVITY_PRESETS.balanced,
          mixCoveragePercent: proSettings.mixCoveragePercent
        });
        setFileName(hydrated.name);
        setProjectName(hydrated.name);
        setLoadedProjectId(hydrated.projectId);
        setLoadedProjectVersion(hydrated.version);
        setCloudMode("loaded");
        // Rehydrate source dimensions + pixel buffer from the stored image
        // so the field sheet / PDF / flattened preview render on load.
        // Unlike upload, we do NOT re-cluster the image — the palette is
        // authoritative from the backend. We only need dimensions and the
        // raw pixel buffer for the flattened-preview painter.
        // Fire-and-forget: if decoding fails, the editor still has the
        // palette and preview image.
        loadImage(hydrated.imageDataUrl)
          .then((image) => {
            if (cancelled) return;
            const canvas = canvasRef.current;
            if (!canvas) return;
            const { width, height } = getScaledDimensions(
              image.naturalWidth,
              image.naturalHeight
            );
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext("2d", { willReadFrequently: true });
            if (!ctx) return;
            ctx.clearRect(0, 0, width, height);
            ctx.drawImage(image, 0, 0, width, height);
            setSourceAnalysis({ width, height, colors: [] });
            const img = ctx.getImageData(0, 0, width, height);
            sourcePixelsRef.current = {
              data: new Uint8ClampedArray(img.data),
              width,
              height
            };
          })
          .catch(() => undefined);
        // Bump lastViewedAt so the dashboard sort stays fresh. Fire-and-forget;
        // we don't need to block hydration on it.
        markViewed(hydrated.projectId).catch(() => undefined);
      } catch (err) {
        if (cancelled) return;
        if (err instanceof UnauthenticatedError) {
          window.location.assign("/signin?returnTo=/");
          return;
        }
        const message =
          err instanceof Error ? err.message : "Couldn't load project.";
        if (/404|not.?found/i.test(message)) {
          setProjectLoadError(
            "Project not found — it may have been deleted."
          );
        } else {
          setProjectLoadError(`Couldn't load project: ${message}`);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isSignedIn]);

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    // Sanitize-first upload pipeline (docs/plans/web-ui-post-backend.md §1 step 9).
    // The sanitizer enforces the allowlist + long-edge cap; the palette is
    // extracted from the sanitized pixel data so the preview and the stored
    // artifact come from the same source of truth.
    const file = event.target.files?.[0];

    if (!file) {
      return;
    }

    const limits = uploadLimits;
    if (!limits) {
      setError("Upload limits are still loading — try again in a moment.");
      return;
    }

    const defaultName = stripExtension(file.name);
    setFileName(file.name);
    setProjectName(defaultName);
    setError(null);
    setSaveMessage("");
    setCloudSaveStatus(null);
    setCloudSaveError(null);
    setVersionConflict(false);
    setProjectLoadError(null);
    setSelectedColorIds([]);
    setMergeKeeperId("");
    setColorFinishOverrides({});
    setColorCoatsOverrides({});
    setFlattenedImageUrl(null);
    sourcePixelsRef.current = null;
    originalClustersRef.current = null;
    setLastClassifiedOptions(null);
    setRecentlyPulledId(null);
    setSanitizedImageBase64(null);
    setThumbnailBase64(null);
    // A new upload means any previously loaded project is no longer the
    // subject of the editor — fall back to "new" (or "idle" for guests).
    setLoadedProjectId(null);
    setLoadedProjectVersion(null);

    startTransition(async () => {
      try {
        // Pipeline A (analysis) and Pipeline B (persistence + visualization)
        // run in parallel and are otherwise independent. See
        // docs/plans/palette-survey-from-original.md for the rationale.
        const [analysis, { sanitized, thumbnail }] = await Promise.all([
          analyzeImage(file, canvasRef.current),
          sanitizeUpload(file, limits)
        ]);

        const sanitizedUrl = URL.createObjectURL(sanitized);
        setPreviewUrl(sanitizedUrl);
        setSourceAnalysis(analysis);

        // Stash the raw bucket list so the art-tap handler can resolve a
        // tapped pixel back to a cluster and pull it out as a locked
        // palette member. Immutable across Auto-combine re-runs.
        originalClustersRef.current = analysis.colors.map((color) => ({ ...color }));

        // Classify-on-upload at the "balanced" preset. We intentionally
        // ignore proSettings.residualThreshold here so the first-experience
        // palette is consistent regardless of any stored user preference;
        // the Auto-combine button still honors proSettings, so users who
        // want a tighter/looser classification can re-run at their
        // preferred sensitivity.
        const uploadClassifyOptions = {
          residualThreshold: SENSITIVITY_PRESETS.balanced,
          mixCoveragePercent: proSettings.mixCoveragePercent
        };
        const classifierInput = analysis.colors.map((color) => ({
          id: color.id,
          rgb: color.rgb,
          pixelCount: color.pixelCount
        }));
        const classifiedList = classifyPaletteColors(classifierInput, uploadClassifyOptions);
        setLastClassifiedOptions(uploadClassifyOptions);
        const { nextColors, mixes } = applyClassification(classifierInput, classifiedList);
        const pixelCountById = new Map(nextColors.map((entry) => [entry.id, entry.pixelCount]));
        const visiblePalette = rebalanceCoverage(
          analysis.colors
            .filter((color) => pixelCountById.has(color.id))
            .map((color) => ({ ...color, pixelCount: pixelCountById.get(color.id)! }))
            .sort((left, right) => right.pixelCount - left.pixelCount)
        );
        const retainedIds = new Set(visiblePalette.map((color) => color.id));
        const nextClassifications: Record<string, PaletteClassification> = {};
        for (const entry of classifiedList) {
          if (!retainedIds.has(entry.id)) continue;
          nextClassifications[entry.id] = entry.classification;
        }
        setPaletteColors(visiblePalette);
        setClassifications(nextClassifications);
        setMixRecipes(mixes);

        // Snapshot the sanitized image into sourcePixelsRef for the
        // flatten-to-palette visualization. Sanitized resolution matches the
        // hydrated-project path (line ~586) and keeps the flatten painter cheap.
        const flattenImage = await loadImage(sanitizedUrl);
        const flattenCanvas = document.createElement("canvas");
        const flattenDims = getScaledDimensions(flattenImage.naturalWidth, flattenImage.naturalHeight);
        flattenCanvas.width = flattenDims.width;
        flattenCanvas.height = flattenDims.height;
        const flattenCtx = flattenCanvas.getContext("2d", { willReadFrequently: true });
        if (flattenCtx) {
          flattenCtx.clearRect(0, 0, flattenDims.width, flattenDims.height);
          flattenCtx.drawImage(flattenImage, 0, 0, flattenDims.width, flattenDims.height);
          const img = flattenCtx.getImageData(0, 0, flattenDims.width, flattenDims.height);
          sourcePixelsRef.current = {
            data: new Uint8ClampedArray(img.data),
            width: flattenDims.width,
            height: flattenDims.height
          };
        }

        // Stash the base64 artifacts so the Save button doesn't have to
        // re-run sanitization — uploads a 25 KB JPEG, fine to keep in
        // memory while the user tweaks.
        const [imageBase64, thumbBase64] = await Promise.all([
          blobToBase64(sanitized),
          blobToBase64(thumbnail)
        ]);
        setSanitizedImageBase64(imageBase64);
        setThumbnailBase64(thumbBase64);
        setCloudMode(isSignedIn ? "new" : "idle");
      } catch (analysisError) {
        setSourceAnalysis(null);
        setPaletteColors([]);
        setSanitizedImageBase64(null);
        setThumbnailBase64(null);
        setCloudMode("idle");
        if (analysisError instanceof UploadSanitizationError) {
          setError(analysisError.message);
        } else {
          setError(
            analysisError instanceof Error
              ? analysisError.message
              : "Image analysis failed."
          );
        }
      }
    });
  }

  function handleBrandChange(nextBrandId: string) {
    setSelectedBrandId(nextBrandId);
    const nextBrand = catalog.brands.find((brand) => brand.id === nextBrandId);

    if (nextBrand) {
      setCoats(String(nextBrand.default_coats));
      // Finish catalogs differ per brand; reset default and drop per-color
      // overrides so we never keep a finishId that isn't valid for the new brand.
      setDefaultFinishId(nextBrand.finishes[0]!.id);
      setColorFinishOverrides({});
      setColorCoatsOverrides({});
    }
  }

  function handleDefaultFinishChange(nextFinishId: string) {
    setDefaultFinishId(nextFinishId);
  }

  function handleColorFinishChange(colorId: string, nextFinishId: string) {
    setColorFinishOverrides((current) => {
      if (nextFinishId === defaultFinishId) {
        const { [colorId]: _removed, ...rest } = current;
        return rest;
      }
      return { ...current, [colorId]: nextFinishId };
    });
  }

  function handleColorCoatsChange(colorId: string, nextCoatsRaw: string) {
    const nextCoats = Number(nextCoatsRaw);
    setColorCoatsOverrides((current) => {
      if (!Number.isFinite(nextCoats) || nextCoats <= 0 || nextCoats === parsedCoats) {
        const { [colorId]: _removed, ...rest } = current;
        return rest;
      }
      return { ...current, [colorId]: nextCoats };
    });
  }

  function handlePrint() {
    if (typeof window !== "undefined") {
      const originalTitle = document.title;
      document.title = buildMaquetteFileName(fileName);
      const restoreTitle = () => {
        document.title = originalTitle;
        window.removeEventListener("afterprint", restoreTitle);
      };
      window.addEventListener("afterprint", restoreTitle);
      window.print();
    }
  }

  async function handleDownloadPdf() {
    if (!fieldSheetModel) {
      return;
    }
    setIsGeneratingPdf(true);
    setPdfError(null);
    try {
      await downloadMaquettePdf({
        model: fieldSheetModel,
        originalImageUrl: previewUrl,
        reducedImageUrl: flattenedImageUrl
      });
    } catch (downloadError) {
      setPdfError(
        downloadError instanceof Error
          ? downloadError.message
          : "Could not generate the maquette PDF."
      );
    } finally {
      setIsGeneratingPdf(false);
    }
  }

  function toggleColorSelection(colorId: string) {
    setSelectedColorIds((current) => {
      if (current.includes(colorId)) {
        const nextSelected = current.filter((entry) => entry !== colorId);

        if (mergeKeeperId === colorId) {
          setMergeKeeperId(nextSelected[0] ?? "");
        }

        return nextSelected;
      }

      const nextSelected = [...current, colorId];

      if (!mergeKeeperId) {
        setMergeKeeperId(colorId);
      }

      return nextSelected;
    });
  }

  function toggleColorDisabled(colorId: string) {
    setPaletteColors((current) =>
      current.map((color) =>
        color.id === colorId
          ? { ...color, disabled: !color.disabled }
          : color
      )
    );
    // Drop the color from the active selection if it was selected — a
    // disabled color can't participate in manual merges either.
    setSelectedColorIds((current) => current.filter((id) => id !== colorId));
    if (mergeKeeperId === colorId) {
      setMergeKeeperId("");
    }
  }

  function toggleColorLocked(colorId: string) {
    setPaletteColors((current) =>
      current.map((color) =>
        color.id === colorId
          ? { ...color, locked: !color.locked }
          : color
      )
    );
  }

  /**
   * Pull a raw cluster out of the auto-merged palette as a new locked
   * standalone swatch. Re-runs `classifyPaletteColors` over the original
   * cluster set with the now-expanded lockedIds — the classifier
   * redistributes the other absorbed clusters around the new locked
   * survivor. See docs/plans/unmerge-colors.md §6-§8.
   */
  function pullColorOut(clusterId: string) {
    const originalClusters = originalClustersRef.current;
    if (!originalClusters) {
      setSaveMessage("Pull is unavailable — re-upload the artwork to enable.");
      return;
    }
    const cluster = originalClusters.find((entry) => entry.id === clusterId);
    if (!cluster) return;
    // No-op if the cluster is already a visible palette member (either as
    // its own swatch or because it survived previous classification).
    if (paletteColors.some((color) => color.id === cluster.id)) {
      setRecentlyPulledId(cluster.id);
      return;
    }

    // Build the new candidate set: current visible palette + the pulled
    // cluster (locked). Disabled colors are excluded from the classifier
    // (matching handleAutoCombine's invariant); they pass through
    // unchanged. The classifier produces a redistributed palette around
    // the expanded locked set.
    const pulledColor: PaletteColor = {
      ...cluster,
      hex: cluster.hex.toUpperCase(),
      locked: true,
      disabled: false
    };

    const disabledColors = paletteColors.filter((color) => color.disabled);
    const enabledColors = paletteColors.filter((color) => !color.disabled);

    // Use the immutable raw clusters as the classifier input. This is the
    // key insight: every Pull re-derives the palette from the original
    // image's full bucket set, with the user's locked picks as constraints.
    // Any locked color that's already in `paletteColors` carries forward
    // because its id is also in the raw clusters.
    const lockedIdsForReclassify = new Set<string>(
      enabledColors.filter((color) => color.locked).map((color) => color.id)
    );
    lockedIdsForReclassify.add(pulledColor.id);

    const options = lastClassifiedOptions ?? {
      residualThreshold: SENSITIVITY_PRESETS.balanced,
      mixCoveragePercent: proSettings.mixCoveragePercent
    };

    const classifierInput = originalClusters.map((color) => ({
      id: color.id,
      rgb: color.rgb,
      pixelCount: color.pixelCount
    }));
    const classifiedList = classifyPaletteColors(classifierInput, {
      ...options,
      lockedIds: lockedIdsForReclassify
    });
    const { nextColors, mixes } = applyClassification(classifierInput, classifiedList);

    // Re-shape into editor PaletteColor[]: pixel counts come from
    // applyClassification; hex/rgb come from the original clusters; the
    // `locked`/`disabled` flags come from the user's existing palette
    // (with the new pulled color flagged locked).
    const clusterById = new Map(originalClusters.map((entry) => [entry.id, entry]));
    const existingFlagsById = new Map<string, { locked?: boolean; disabled?: boolean }>(
      paletteColors.map((color) => [color.id, { locked: color.locked, disabled: color.disabled }])
    );
    existingFlagsById.set(pulledColor.id, { locked: true, disabled: false });

    const pixelCountById = new Map(nextColors.map((entry) => [entry.id, entry.pixelCount]));
    const reclassifiedPalette: PaletteColor[] = nextColors
      .map((entry) => {
        const source = clusterById.get(entry.id);
        if (!source) return null;
        const flags = existingFlagsById.get(entry.id) ?? {};
        return {
          id: source.id,
          hex: source.hex.toUpperCase(),
          rgb: source.rgb,
          pixelCount: pixelCountById.get(entry.id) ?? source.pixelCount,
          coveragePercent: 0,
          ...flags
        } satisfies PaletteColor;
      })
      .filter((entry): entry is PaletteColor => entry !== null);

    // Re-prepend disabled colors that were excluded from the classifier
    // pass — they pass through unchanged.
    const nextPalette = rebalanceCoverage(
      [...reclassifiedPalette, ...disabledColors].sort(
        (left, right) => right.pixelCount - left.pixelCount
      )
    );

    const retainedIds = new Set(nextPalette.map((color) => color.id));
    const nextClassifications: Record<string, PaletteClassification> = {};
    for (const entry of classifiedList) {
      if (!retainedIds.has(entry.id)) continue;
      nextClassifications[entry.id] = entry.classification;
    }

    setPaletteColors(nextPalette);
    setClassifications(nextClassifications);
    setMixRecipes(mixes);
    setRecentlyPulledId(pulledColor.id);
  }

  /**
   * Map a tap on a preview <img> back to a quantized cluster in
   * originalClustersRef. Source preview = "proactive" intent; flatten
   * preview = "reactive" intent; mechanism is identical. See
   * docs/plans/unmerge-colors.md §7-§8.
   */
  function handleArtTap(event: React.MouseEvent<HTMLImageElement>) {
    const source = sourcePixelsRef.current;
    const originalClusters = originalClustersRef.current;
    if (!source || !originalClusters) return;

    const img = event.currentTarget;
    const rect = img.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const normX = (event.clientX - rect.left) / rect.width;
    const normY = (event.clientY - rect.top) / rect.height;
    if (normX < 0 || normX > 1 || normY < 0 || normY > 1) return;

    const srcX = Math.min(source.width - 1, Math.max(0, Math.floor(normX * source.width)));
    const srcY = Math.min(source.height - 1, Math.max(0, Math.floor(normY * source.height)));
    const dataIdx = (srcY * source.width + srcX) * 4;
    const alpha = source.data[dataIdx + 3] ?? 0;
    if (alpha < 128) return;

    const r = source.data[dataIdx] ?? 0;
    const g = source.data[dataIdx + 1] ?? 0;
    const b = source.data[dataIdx + 2] ?? 0;
    const qr = Math.round(r / 12) * 12;
    const qg = Math.round(g / 12) * 12;
    const qb = Math.round(b / 12) * 12;

    // Find the cluster whose stored rgb quantizes to the tapped centroid.
    // bucketPixels keys by quantized rgb, so each (qr,qg,qb) maps to at
    // most one cluster.
    const match = originalClusters.find((cluster) => {
      const cr = Math.round(cluster.rgb[0] / 12) * 12;
      const cg = Math.round(cluster.rgb[1] / 12) * 12;
      const cb = Math.round(cluster.rgb[2] / 12) * 12;
      return cr === qr && cg === qg && cb === qb;
    });
    if (!match) return;

    pullColorOut(match.id);
  }

  function mergeSelectedColors() {
    if (selectedColorIds.length < 2 || !mergeKeeperId) {
      return;
    }

    const selectedColors = paletteColors.filter((color) => selectedColorIds.includes(color.id));
    const keeper = selectedColors.find((color) => color.id === mergeKeeperId);

    if (!keeper) {
      return;
    }

    const mergedPixelCount = selectedColors.reduce((sum, color) => sum + color.pixelCount, 0);
    const totalPixels = paletteColors.reduce((sum, color) => sum + color.pixelCount, 0);
    const mergedKeeper: PaletteColor = {
      ...keeper,
      pixelCount: mergedPixelCount,
      coveragePercent: (mergedPixelCount / totalPixels) * 100
    };

    const nextPalette = paletteColors
      .filter((color) => !selectedColorIds.includes(color.id) || color.id === mergeKeeperId)
      .map((color) => (color.id === mergeKeeperId ? mergedKeeper : color))
      .sort((left, right) => right.pixelCount - left.pixelCount);

    setPaletteColors(rebalanceCoverage(nextPalette));
    const retainedIds = new Set(nextPalette.map((color) => color.id));
    setColorFinishOverrides((current) => {
      const next: Record<string, string> = {};
      for (const [colorId, finishId] of Object.entries(current)) {
        if (retainedIds.has(colorId)) {
          next[colorId] = finishId;
        }
      }
      return next;
    });
    setColorCoatsOverrides((current) => {
      const next: Record<string, number> = {};
      for (const [colorId, coatsValue] of Object.entries(current)) {
        if (retainedIds.has(colorId)) {
          next[colorId] = coatsValue;
        }
      }
      return next;
    });
    setSelectedColorIds([]);
    setMergeKeeperId("");
    setSaveMessage("");
    // Manual merge invalidates any prior auto-combine classifications — the
    // recipes and absorb marks were based on the old palette composition.
    setClassifications({});
    setMixRecipes([]);
  }

  function handleAutoCombine() {
    // Disabled colors bypass the classifier entirely so they don't pull
    // into mix recipes or get re-absorbed; they pass through to the next
    // palette as-is, with their classification preserved.
    const enabledColors = paletteColors.filter((color) => !color.disabled);
    const disabledColors = paletteColors.filter((color) => color.disabled);

    if (enabledColors.length < 3) {
      setSaveMessage("Need at least three captured colors before auto-combine can help.");
      return;
    }

    const classifierInput = enabledColors.map((color) => ({
      id: color.id,
      rgb: color.rgb,
      pixelCount: color.pixelCount
    }));

    const lockedIds = new Set(
      enabledColors.filter((color) => color.locked).map((color) => color.id)
    );
    const autoCombineOptions = {
      residualThreshold: proSettings.residualThreshold,
      mixCoveragePercent: proSettings.mixCoveragePercent
    };
    const classifiedList = classifyPaletteColors(classifierInput, {
      ...autoCombineOptions,
      lockedIds
    });
    setLastClassifiedOptions(autoCombineOptions);
    const { nextColors, mixes, absorbedCount } = applyClassification(classifierInput, classifiedList);

    if (absorbedCount === 0 && mixes.length === 0) {
      setSaveMessage("Nothing to auto-combine — no gradient or mix members detected.");
      return;
    }

    const pixelCountById = new Map(nextColors.map((entry) => [entry.id, entry.pixelCount]));
    const nextPalette: PaletteColor[] = [
      ...enabledColors
        .filter((color) => pixelCountById.has(color.id))
        .map((color) => ({ ...color, pixelCount: pixelCountById.get(color.id)! })),
      ...disabledColors
    ]
      .sort((left, right) => right.pixelCount - left.pixelCount);

    const rebalanced = rebalanceCoverage(nextPalette);
    const retainedIds = new Set(rebalanced.map((color) => color.id));

    setColorFinishOverrides((current) => {
      const next: Record<string, string> = {};
      for (const [colorId, finishId] of Object.entries(current)) {
        if (retainedIds.has(colorId)) next[colorId] = finishId;
      }
      return next;
    });
    setColorCoatsOverrides((current) => {
      const next: Record<string, number> = {};
      for (const [colorId, coatsValue] of Object.entries(current)) {
        if (retainedIds.has(colorId)) next[colorId] = coatsValue;
      }
      return next;
    });
    setSelectedColorIds([]);
    setMergeKeeperId("");

    const nextClassifications: Record<string, PaletteClassification> = {};
    for (const entry of classifiedList) {
      if (!retainedIds.has(entry.id)) continue;
      nextClassifications[entry.id] = entry.classification;
    }

    setPaletteColors(rebalanced);
    setClassifications(nextClassifications);
    setMixRecipes(mixes);

    const buyCount = Object.values(nextClassifications).filter((entry) => entry === "buy").length;
    setSaveMessage(
      `Kept ${buyCount} to buy, flagged ${mixes.length} to mix, absorbed ${absorbedCount} gradient ${absorbedCount === 1 ? "color" : "colors"}.`
    );
  }

  function saveMergedChoices() {
    if (typeof window === "undefined" || paletteColors.length === 0) {
      return;
    }
    // Defense-in-depth: the button is hidden for signed-in users, but if a
    // signed-in caller somehow reaches this function, skip localStorage so
    // the server stays authoritative.
    if (isSignedIn === true) {
      return;
    }

    const nextSavedPlan: SavedMergePlan = {
      savedAt: new Date().toISOString(),
      fileName,
      selectedBrandId,
      wallLength,
      wallWidth,
      gridCellSize,
      artistNotes,
      coats,
      wastePercent,
      sourceAnalysis,
      paletteColors,
      defaultFinishId,
      colorFinishOverrides,
      colorCoatsOverrides,
      classifications,
      mixRecipes
    };

    window.localStorage.setItem(savedMergePlanKey, JSON.stringify(nextSavedPlan));
    setSavedMergePlan(nextSavedPlan);
    setSaveMessage("Merged choices saved on this device.");
  }

  function buildEditorSnapshot(): EditorSnapshot {
    return {
      paletteColors,
      // Persist the immutable upload-time raw cluster set so a future
      // session's art-tap / pull-color flow has the merge graph to work
      // against. Omit when null (no raw clusters captured yet, e.g. for a
      // session that loaded a legacy project pre-feature).
      originalPaletteColors: originalClustersRef.current ?? undefined,
      classifications,
      mixRecipes,
      colorFinishOverrides,
      colorCoatsOverrides
    };
  }

  function formatCloudSaveError(err: unknown): string {
    if (err instanceof OverLimitError) {
      return "You've hit your free-tier limit of 3 projects — delete one or upgrade.";
    }
    if (err instanceof UnauthenticatedError) {
      return "Your session expired — please sign in again.";
    }
    if (err instanceof Error) return err.message;
    return "Couldn't save project.";
  }

  async function handleCloudSaveNew(options: { redirectOnSuccess?: boolean } = {}) {
    if (!sanitizedImageBase64 || !thumbnailBase64 || paletteColors.length === 0) {
      setCloudSaveError("Nothing to save yet — upload an image first.");
      return;
    }
    setCloudSaveStatus("Saving…");
    setCloudSaveError(null);
    setVersionConflict(false);
    const nameTrimmed = projectName.trim();
    const safeName = nameTrimmed.length > 0 ? nameTrimmed : stripExtension(fileName) || "Untitled project";
    try {
      const payload = buildCreateProjectPayload({
        name: safeName,
        snapshot: buildEditorSnapshot(),
        sanitizedImageBase64,
        thumbnailBase64
      });
      const created = await createProject(payload);
      setCloudSaveStatus("Saved ✓");
      setLoadedProjectId(created.id);
      setLoadedProjectVersion(created.version);
      setCloudMode("loaded");
      if (options.redirectOnSuccess && typeof window !== "undefined") {
        window.location.assign("/projects");
      }
    } catch (err) {
      if (err instanceof UnauthenticatedError) {
        if (typeof window !== "undefined") {
          window.location.assign("/signin?returnTo=/");
        }
        return;
      }
      setCloudSaveStatus(null);
      setCloudSaveError(formatCloudSaveError(err));
    }
  }

  async function handleCloudSaveChanges() {
    if (!loadedProjectId || loadedProjectVersion === null) return;
    if (paletteColors.length === 0) {
      setCloudSaveError("Nothing to save — the palette is empty.");
      return;
    }
    setCloudSaveStatus("Saving…");
    setCloudSaveError(null);
    setVersionConflict(false);
    try {
      const palette = buildPaletteJson(buildEditorSnapshot());
      await updatePalette(loadedProjectId, palette, loadedProjectVersion);
      setCloudSaveStatus("Saved ✓");
      setLoadedProjectVersion(loadedProjectVersion + 1);
    } catch (err) {
      setCloudSaveStatus(null);
      if (err instanceof VersionConflictError) {
        setVersionConflict(true);
        setCloudSaveError(
          "Another tab or session saved this project — reload to see the latest, or save as a new copy."
        );
        return;
      }
      if (err instanceof UnauthenticatedError) {
        if (typeof window !== "undefined") {
          window.location.assign("/signin?returnTo=/");
        }
        return;
      }
      setCloudSaveError(formatCloudSaveError(err));
    }
  }

  function handleReloadProject() {
    if (typeof window !== "undefined") {
      window.location.reload();
    }
  }

  async function handleSaveAsCopy() {
    // Break the link to the existing project so the user gets a fresh one
    // with their current in-memory palette state.
    setLoadedProjectId(null);
    setLoadedProjectVersion(null);
    setCloudMode("new");
    setVersionConflict(false);
    await handleCloudSaveNew();
  }

  function restoreSavedChoices() {
    if (!savedMergePlan) {
      return;
    }

    setFileName(savedMergePlan.fileName);
    setSelectedBrandId(savedMergePlan.selectedBrandId);
    setWallLength(savedMergePlan.wallLength);
    setWallWidth(savedMergePlan.wallWidth);
    setGridCellSize(savedMergePlan.gridCellSize ?? "2");
    setArtistNotes(savedMergePlan.artistNotes ?? "");
    setCoats(savedMergePlan.coats);
    setWastePercent(savedMergePlan.wastePercent);
    setSourceAnalysis(savedMergePlan.sourceAnalysis);
    setPaletteColors(savedMergePlan.paletteColors);
    const restoredDefaultFinish =
      savedMergePlan.defaultFinishId ?? defaultFinishForBrand(savedMergePlan.selectedBrandId);
    setDefaultFinishId(restoredDefaultFinish);
    setColorFinishOverrides(savedMergePlan.colorFinishOverrides ?? {});
    setColorCoatsOverrides(savedMergePlan.colorCoatsOverrides ?? {});
    setClassifications(savedMergePlan.classifications ?? {});
    setMixRecipes(savedMergePlan.mixRecipes ?? []);
    setSelectedColorIds([]);
    setMergeKeeperId("");
    setSaveMessage("Saved merged choices restored.");
  }

  return (
    <main className="page-shell">
      <section className="hero hero-grid">
        <div>
          <p className="eyebrow">Paint Estimator</p>
          <h1>Muralist</h1>
          <p className="lede">
            Upload mural artwork, capture the dominant paint colors, then merge chips into a practical
            field palette and estimate real can sizes.
          </p>
          <p className="hero-note">
            This workflow starts broad, then lets you decide which close shades should collapse into a single paint choice.
          </p>
        </div>
        <div className="hero-panel">
          <div className="metrics">
            <div>
              <span className="metric-label">Palette capture</span>
              <strong>
                {paletteColors.length > 0
                  ? `${paletteColors.length} swatch${paletteColors.length === 1 ? "" : "es"}`
                  : "Awaiting upload"}
              </strong>
            </div>
            <div>
              <span className="metric-label">Brand default</span>
              <strong>{selectedBrand.display_name}</strong>
            </div>
            <div>
              <span className="metric-label">Coverage</span>
              <strong>{selectedBrand.coverage.default} sq ft/gal</strong>
            </div>
          </div>
        </div>
      </section>

      <ProSettingsPanel
        open={showProSettings}
        onToggle={() => setShowProSettings((current) => !current)}
        settings={proSettings}
        onSettingsChange={setProSettings}
        isSignedIn={isSignedIn}
      />

      <section className="workspace-grid">
        <section className="panel">
          <div className="section-head">
            <h2>1. Upload Artwork</h2>
            <p>Choose an image and capture the strongest paint candidates from it.</p>
          </div>

          <label className="upload-zone">
            <input
              className="hidden-input"
              type="file"
              accept="image/*"
              onChange={handleFileChange}
            />
            <span className="upload-title">Choose Image</span>
            <span className="upload-copy">
              PNG, JPG, WEBP, and other browser-supported image formats.
            </span>
          </label>

          {error ? <p className="status error">{error}</p> : null}
          {isPending ? <p className="status">Capturing dominant colors from the artwork...</p> : null}

          {previewUrl ? (
            <div className="preview-frame">
              <img alt={fileName || "Uploaded mural preview"} className="preview-image" src={previewUrl} />
              <div className="preview-meta">
                <strong>{fileName}</strong>
                {sourceAnalysis ? (
                  <span>
                    {sourceAnalysis.width} × {sourceAnalysis.height} analyzed
                  </span>
                ) : null}
              </div>
            </div>
          ) : (
            <div className="empty-frame">
              Upload artwork to generate a paint-ready color list.
            </div>
          )}
        </section>

        <section className="panel">
          <div className="section-head">
            <h2>2. Estimate Paint</h2>
            <p>Use wall dimensions and brand coverage assumptions to get can-size recommendations.</p>
          </div>

          <div className="form-grid">
            <label className="field">
              <span>Paint brand</span>
              <select value={selectedBrandId} onChange={(event) => handleBrandChange(event.target.value)}>
                {catalog.brands.map((brand) => (
                  <option key={brand.id} value={brand.id}>
                    {brand.display_name} ({brand.retailer})
                  </option>
                ))}
              </select>
            </label>

            <label className="field">
              <span>Finish</span>
              <select
                value={defaultFinishId}
                onChange={(event) => handleDefaultFinishChange(event.target.value)}
              >
                {selectedBrand.finishes.map((finish) => (
                  <option key={finish.id} value={finish.id}>
                    {finish.display_name}
                  </option>
                ))}
              </select>
            </label>

            <label className="field">
              <span>Wall width (ft)</span>
              <input
                type="number"
                min="1"
                value={wallLength}
                onChange={(event) => setWallLength(event.target.value)}
              />
            </label>

            <label className="field">
              <span>Wall height (ft)</span>
              <input
                type="number"
                min="1"
                value={wallWidth}
                onChange={(event) => setWallWidth(event.target.value)}
              />
            </label>

            <label className="field">
              <span>Grid cells</span>
              <select value={gridCellSize} onChange={(event) => setGridCellSize(event.target.value)}>
                <option value="1">1 ft squares</option>
                <option value="2">2 ft squares</option>
                <option value="4">4 ft squares</option>
              </select>
            </label>

            <label className="field">
              <span>Coats</span>
              <input
                type="number"
                min="1"
                value={coats}
                onChange={(event) => setCoats(event.target.value)}
              />
            </label>

            <label className="field field-wide">
              <span>Waste / overage (%)</span>
              <input
                type="number"
                min="0"
                value={wastePercent}
                onChange={(event) => setWastePercent(event.target.value)}
              />
            </label>
          </div>

          <div className="estimate-banner">
            <div>
              <span className="metric-label">Wall area</span>
              <strong>{Number.isFinite(wallArea) && wallArea > 0 ? `${wallArea.toFixed(1)} sq ft` : "--"}</strong>
            </div>
            <div>
              <span className="metric-label">Minimum can</span>
              <strong>1 qt</strong>
            </div>
          </div>
        </section>
      </section>

      <section className="panel results-panel">
        <div className="section-head">
          <h2>3. Paint Palette</h2>
          <p>
            Start from the strongest colors in the artwork, then select multiple chips to merge them into one keeper color.
          </p>
        </div>

        {paletteColors.length > 0 ? (
          <>
            <div className="summary-strip">
              <div>
                <span className="metric-label">Captured colors</span>
                <strong>{paletteColors.length}</strong>
              </div>
              <div>
                <span className="metric-label">Selected to merge</span>
                <strong>{selectedColorIds.length}</strong>
              </div>
              <div>
                <span className="metric-label">Estimated total</span>
                <strong>{containerPlan ? formatContainerTotals(containerPlan.totals) : "--"}</strong>
              </div>
            </div>

            <div className="merge-toolbar">
              <div className="merge-toolbar-copy">
                <strong>Selected chips</strong>
                <span>Pick 2 or more colors, choose the keeper chip, then merge them.</span>
                {isSignedIn === false && savedMergePlan ? (
                  <small className="saved-note">
                    Last saved {formatSavedAt(savedMergePlan.savedAt)}
                    {savedMergePlan.fileName ? ` from ${savedMergePlan.fileName}` : ""}.
                  </small>
                ) : null}
              </div>
              <div className="merge-controls">
                <label className="field merge-field">
                  <span>Keep this color</span>
                  <select
                    value={mergeKeeperId}
                    disabled={mergeOptions.length < 2}
                    onChange={(event) => setMergeKeeperId(event.target.value)}
                  >
                    <option value="">Choose keeper</option>
                    {mergeOptions.map((color) => (
                      <option key={color.id} value={color.id}>
                        {color.hex}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  className="merge-button"
                  disabled={mergeOptions.length < 2 || !mergeKeeperId}
                  onClick={mergeSelectedColors}
                  type="button"
                >
                  Merge Selected
                </button>
                <button
                  className="save-button auto-combine-button"
                  disabled={paletteColors.length < 3}
                  onClick={handleAutoCombine}
                  type="button"
                  title="Re-classify the palette at the current sensitivity. Classification runs automatically on upload; click to re-run after adjusting sensitivity in Pro Settings."
                >
                  Auto-combine similar colors
                </button>
                {isSignedIn === false ? (
                  <button
                    className="save-button"
                    disabled={paletteColors.length === 0}
                    onClick={saveMergedChoices}
                    type="button"
                    title="Saved to this device only. Sign in to save to your account."
                  >
                    Save Merge Choices
                  </button>
                ) : null}
                <CloudSaveControls
                  isSignedIn={isSignedIn}
                  cloudMode={cloudMode}
                  paletteColorCount={paletteColors.length}
                  hasSanitizedImage={!!sanitizedImageBase64}
                  projectName={projectName}
                  onProjectNameChange={setProjectName}
                  cloudSaveStatus={cloudSaveStatus}
                  onSaveNew={() => handleCloudSaveNew({ redirectOnSuccess: false })}
                  onSaveChanges={handleCloudSaveChanges}
                />
                <button
                  className="pdf-button"
                  disabled={!fieldSheetModel || isGeneratingPdf}
                  onClick={handleDownloadPdf}
                  type="button"
                >
                  {isGeneratingPdf ? "Generating PDF..." : "Download Maquette PDF"}
                </button>
                <button
                  className="print-button print-button-fallback"
                  disabled={paletteColors.length === 0}
                  onClick={handlePrint}
                  type="button"
                  title="Fallback: render the HTML field sheet through the browser print dialog."
                >
                  Print (fallback)
                </button>
                {isSignedIn === false && savedMergePlan ? (
                  <button className="restore-button" onClick={restoreSavedChoices} type="button">
                    Restore Saved Palette
                  </button>
                ) : null}
              </div>
            </div>

            {saveMessage ? <p className="status">{saveMessage}</p> : null}
            {pdfError ? <p className="status error">{pdfError}</p> : null}
            {cloudSaveStatus && cloudSaveStatus !== "Saving…" ? (
              <p className="status">
                {cloudSaveStatus}
                {loadedProjectId ? (
                  <>
                    {" · "}
                    <a href="/projects">View in Projects</a>
                  </>
                ) : null}
              </p>
            ) : null}
            {cloudSaveStatus === "Saving…" ? (
              <p className="status">Saving…</p>
            ) : null}
            {cloudSaveError ? (
              <p className="status error" role="alert">
                {cloudSaveError}
              </p>
            ) : null}
            {versionConflict ? (
              <div className="status cloud-conflict-actions" role="alert">
                <button
                  className="save-button"
                  onClick={handleReloadProject}
                  type="button"
                >
                  Reload
                </button>
                <button
                  className="save-button"
                  onClick={handleSaveAsCopy}
                  type="button"
                >
                  Save as new
                </button>
              </div>
            ) : null}
            {projectLoadError ? (
              <p className="status error" role="alert">
                {projectLoadError}
              </p>
            ) : null}

            <div className="selection-strip">
              {selectedColorIds.length > 0 ? (
                paletteColors
                  .filter((color) => selectedColorIds.includes(color.id))
                  .map((color) => (
                    <button
                      className={`selected-chip ${mergeKeeperId === color.id ? "keeper-chip" : ""}`}
                      key={color.id}
                      onClick={() => setMergeKeeperId(color.id)}
                      type="button"
                    >
                      <span className="selected-chip-swatch" style={{ backgroundColor: color.hex }} />
                      <span>{color.hex}</span>
                      <small>{mergeKeeperId === color.id ? "keeper" : "selected"}</small>
                    </button>
                  ))
              ) : (
                <div className="empty-selection">Select chips below to start a manual merge.</div>
              )}
            </div>

            <p className="palette-skip-help">
              Use <strong>Skip in estimate</strong> on a color to leave it out of the paint plan and maquette — useful for backgrounds that are bare wall, not painted.
            </p>

            <div className="palette-grid">
              {paletteColors.map((color) => {
                const isSelected = selectedColorIds.includes(color.id);
                const colorPlan = planByColorId.get(color.id) ?? null;
                const effectiveFinishId = colorFinishOverrides[color.id] ?? defaultFinishId;
                const classification = classifications[color.id] ?? "buy";
                const isMix = classification === "mix";
                const recipe = isMix ? mixRecipes.find((entry) => entry.targetColorId === color.id) : undefined;
                const isDisabled = color.disabled === true;
                const isLocked = color.locked === true;
                const isRecentlyPulled = recentlyPulledId === color.id;

                return (
                  <article
                    className={`swatch-card ${isSelected ? "swatch-card-selected" : ""} ${isMix ? "swatch-card-mix" : ""} ${isDisabled ? "swatch-card-disabled" : ""} ${isLocked ? "swatch-card-locked" : ""} ${isRecentlyPulled ? "swatch-card-just-pulled" : ""}`}
                    key={color.id}
                  >
                    <button
                      className="swatch-toggle"
                      onClick={() => toggleColorSelection(color.id)}
                      type="button"
                      disabled={isDisabled}
                    >
                      <div
                        className={`swatch ${isDisabled ? "swatch-disabled-hatch" : ""}`}
                        style={isDisabled ? undefined : { backgroundColor: color.hex }}
                      />
                      {isLocked ? (
                        <span className="swatch-locked-overlay" aria-hidden="true">🔒</span>
                      ) : null}
                    </button>
                    <div className="swatch-body">
                      <div className="swatch-title-row">
                        <strong>{color.hex}</strong>
                        <span>{color.coveragePercent.toFixed(1)}%</span>
                      </div>
                      <div className="swatch-pill-row">
                        <button
                          className={`swatch-skip-pill ${isDisabled ? "is-skipped" : ""}`}
                          onClick={() => toggleColorDisabled(color.id)}
                          type="button"
                          title={
                            isDisabled
                              ? "Include this color in the estimate and maquette again."
                              : "Skip this color from the estimate and maquette. Useful for backgrounds that are bare wall."
                          }
                        >
                          {isDisabled ? "Skipped — click to include" : "Skip in estimate"}
                        </button>
                        <button
                          className={`swatch-lock-pill ${isLocked ? "is-locked" : ""}`}
                          onClick={() => toggleColorLocked(color.id)}
                          type="button"
                          title={
                            isLocked
                              ? "Unlock this color so Auto-combine can merge it again."
                              : "Lock this color so Auto-combine won't merge it away."
                          }
                          aria-label={isLocked ? "Unlock color" : "Lock color"}
                        >
                          {isLocked ? "🔒 Locked" : "🔓 Lock"}
                        </button>
                      </div>
                      {isMix ? (
                        <p className="mix-recipe-line">
                          <span className="mix-badge">mix</span>{" "}
                          {recipe ? describeMixRecipe(recipe, paletteColors) : "combine two buy colors"}
                        </p>
                      ) : (
                        <p>{color.pixelCount.toLocaleString()} sampled pixels in this working color.</p>
                      )}
                      <label className="field field-inline swatch-finish">
                        <span>Finish</span>
                        <select
                          value={effectiveFinishId}
                          onChange={(event) => handleColorFinishChange(color.id, event.target.value)}
                          disabled={isDisabled}
                        >
                          {selectedBrand.finishes.map((finish) => (
                            <option key={finish.id} value={finish.id}>
                              {finish.display_name}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="field field-inline swatch-coats">
                        <span>Coats</span>
                        <input
                          type="number"
                          min="1"
                          value={colorCoatsOverrides[color.id] ?? (Number.isFinite(parsedCoats) ? parsedCoats : 2)}
                          onChange={(event) => handleColorCoatsChange(color.id, event.target.value)}
                          disabled={isDisabled}
                        />
                      </label>
                      <div className="estimate-row">
                        <span>{selectedBrand.display_name}</span>
                        <strong>{isDisabled ? "Skipped" : (colorPlan ? formatContainerPackages(colorPlan) : "--")}</strong>
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>

            {fieldSheetModel ? (
              <FieldSheet
                model={fieldSheetModel}
                originalImageUrl={previewUrl}
                reducedImageUrl={flattenedImageUrl}
                onArtistNotesChange={setArtistNotes}
                onArtTap={handleArtTap}
              />
            ) : null}
          </>
        ) : (
          <div className="empty-results">
            Upload an image to capture the strongest colors and build your paint plan.
          </div>
        )}
      </section>

      <canvas className="hidden-canvas" ref={canvasRef} />
    </main>
  );
}

function FieldSheet({
  model,
  originalImageUrl,
  reducedImageUrl,
  onArtistNotesChange,
  onArtTap
}: {
  model: FieldSheetModel;
  originalImageUrl: string | null;
  reducedImageUrl: string | null;
  onArtistNotesChange: (notes: string) => void;
  onArtTap?: (event: React.MouseEvent<HTMLImageElement>) => void;
}) {
  const gridLines = buildGridLinePositions(model.wall, model.grid);
  const sourceAspectRatio = model.sourceSize.widthPx / model.sourceSize.heightPx;
  const wallAspectRatio = model.wall.widthFt / model.wall.heightFt;

  return (
    <section className="print-summary field-sheet" aria-labelledby="field-sheet-heading">
      <h3 id="field-sheet-heading" className="field-sheet-title">Scaled Paint Plan</h3>

      {model.aspectRatio.shouldWarn ? (
        <div className="ratio-warning" role="status">
          Your wall ratio differs from the uploaded artwork. The mural preview is stretched to the wall size so you can catch the mismatch before painting.
        </div>
      ) : null}

      <div className="field-sheet-grid">
        <div className="field-sheet-visuals">
          <GridPreview
            aspectRatio={sourceAspectRatio}
            gridLines={gridLines}
            imageFit="fill"
            imageUrl={originalImageUrl}
            label="Original artwork"
            note="Source ratio preserved. Grid spacing may differ by direction when the wall ratio does not match."
            onTap={onArtTap}
            tapHint="Tap a color you want to keep — we'll pull it back into the palette."
          />
          <GridPreview
            aspectRatio={wallAspectRatio}
            gridLines={gridLines}
            imageFit="fill"
            imageUrl={reducedImageUrl}
            label="Reduced mural preview"
            note="Fit to entered wall dimensions. Grid cells represent real-world spacing."
            onTap={onArtTap}
            tapHint="Tap a region whose color is wrong — we'll pull the right color in."
          />
          <dl className="field-sheet-scale">
            <div>
              <dt>Wall</dt>
              <dd>{model.wall.widthFt} ft × {model.wall.heightFt} ft</dd>
            </div>
            <div>
              <dt>Grid</dt>
              <dd>{model.grid.columns} × {model.grid.rows} cells at {model.grid.cellSizeFt} ft</dd>
            </div>
            <div>
              <dt>Edge cells</dt>
              <dd>{formatPartialGridNotice(model.grid)}</dd>
            </div>
          </dl>
        </div>

        <div className="field-sheet-palette">
          <div className="field-sheet-mix-space" aria-label="Artist swatch testing and math space" />
          <table className="print-summary-table field-sheet-table">
            <thead>
              <tr>
                <th scope="col">Paint-over swatch</th>
                <th scope="col">Plan</th>
              </tr>
            </thead>
            <tbody>
              {model.colors.map((color) => (
                <tr key={color.colorId}>
                  <th scope="row">
                    <svg
                      className="paint-over-swatch"
                      role="img"
                      aria-label={`Paint-over swatch for ${color.hex}`}
                      viewBox="0 0 100 100"
                    >
                      <rect width="100" height="100" fill={color.hex} />
                    </svg>
                  </th>
                  <td>
                    <strong>{color.hex}</strong>
                    <span>{color.coveragePercent.toFixed(1)}% · {color.areaSqFt.toFixed(1)} sq ft</span>
                    <span>{color.finishLabel} · {color.coats} coats</span>
                    <span>{color.packageLabel}</span>
                    <span>{formatOunces(color.requiredGallons)} · {formatCurrency(color.estimatedCost, model.currency)}</span>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row">Totals</th>
                <td>
                  <strong>{model.totals.packageLabel}</strong>
                  <span>{formatOunces(model.totals.requiredGallons)} · {formatCurrency(model.totals.estimatedCost, model.currency)}</span>
                </td>
              </tr>
            </tfoot>
          </table>
        </div>

        <aside className="field-sheet-notes" aria-label="Artist notes">
          <label className="field-sheet-notes-label" htmlFor="artist-notes">
            Notes
          </label>
          <textarea
            id="artist-notes"
            value={model.artistNotes}
            onChange={(event) => onArtistNotesChange(event.target.value)}
            placeholder="Store notes, coat notes, substitutions, and on-site adjustments."
          />
          <div className="field-sheet-print-notes">
            {model.artistNotes || "Store notes, coat notes, substitutions, and on-site adjustments."}
          </div>
        </aside>
      </div>

      <footer className="print-summary-footnote field-sheet-footer">
        <strong>Total: {model.totals.packageLabel}</strong>
        <span>{formatOunces(model.totals.requiredGallons)} · {formatCurrency(model.totals.estimatedCost, model.currency)}</span>
        <span>{model.brandLabel} ({model.retailer}) · {model.wall.areaSqFt.toFixed(0)} sq ft · {model.colors.length} colors · {model.grid.cellSizeFt} ft grid. Paint over swatches with your final mixes before matching in store.</span>
      </footer>
    </section>
  );
}

function GridPreview({
  aspectRatio,
  gridLines,
  imageFit,
  imageUrl,
  label,
  note,
  onTap,
  tapHint
}: {
  aspectRatio: number;
  gridLines: { vertical: number[]; horizontal: number[] };
  imageFit: "contain" | "fill";
  imageUrl: string | null;
  label: string;
  note: string;
  onTap?: (event: React.MouseEvent<HTMLImageElement>) => void;
  tapHint?: string;
}) {
  const isInteractive = Boolean(onTap && imageUrl);
  return (
    <figure className="grid-preview">
      {isInteractive && tapHint ? (
        <p className="grid-preview-tap-hint" aria-hidden="true">{tapHint}</p>
      ) : null}
      <div className="grid-preview-frame" style={{ aspectRatio }}>
        {imageUrl ? (
          <img
            alt={label}
            className={`grid-preview-image grid-preview-image-${imageFit} ${isInteractive ? "is-tappable" : ""}`}
            src={imageUrl}
            onClick={isInteractive ? onTap : undefined}
            role={isInteractive ? "button" : undefined}
          />
        ) : (
          <div className="grid-preview-empty">Preview will appear here.</div>
        )}
        <svg className="grid-overlay" aria-hidden="true" focusable="false" viewBox="0 0 100 100" preserveAspectRatio="none">
          {gridLines.vertical.map((position) => (
            <line key={`v-${position}`} x1={position} x2={position} y1="0" y2="100" />
          ))}
          {gridLines.horizontal.map((position) => (
            <line key={`h-${position}`} x1="0" x2="100" y1={position} y2={position} />
          ))}
        </svg>
      </div>
      <figcaption>
        <strong>{label}</strong>
        <span>{note}</span>
      </figcaption>
    </figure>
  );
}

/**
 * The sole palette-survey entry point. Always receives the original upload
 * `File`; never the sanitized blob or thumbnail. The sanitized artifacts
 * exist only for persistence + visualization (Pipeline B) and must not be
 * the analysis source — see docs/plans/palette-survey-from-original.md.
 */
async function analyzeImage(file: File, canvas: HTMLCanvasElement | null) {
  const imageUrl = URL.createObjectURL(file);

  try {
    const image = await loadImage(imageUrl);
    return analyzeLoadedImage(image, canvas);
  } finally {
    URL.revokeObjectURL(imageUrl);
  }
}

function analyzeLoadedImage(image: HTMLImageElement, canvas: HTMLCanvasElement | null): AnalysisResult {
  if (!canvas) {
    throw new Error("Canvas is unavailable.");
  }

  // Survey runs at the full natural resolution of the original upload. The
  // sanitized + thumbnail artifacts are visualization/persistence only and
  // must never be the analysis source — see docs/plans/palette-survey-from-original.md.
  const width = image.naturalWidth;
  const height = image.naturalHeight;
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext("2d", { willReadFrequently: true });

  if (!context) {
    throw new Error("2D canvas context is unavailable.");
  }

  context.clearRect(0, 0, width, height);
  context.drawImage(image, 0, 0, width, height);

  const imageData = context.getImageData(0, 0, width, height);
  const sampled = samplePixels(imageData.data);

  if (!sampled.length) {
    throw new Error("No visible pixels were found in this image.");
  }

  const initialClusters = bucketPixels(sampled);
  // No top-N cut by raw pixelCount — classifyPaletteColors runs at the
  // upload call site and is the only legitimate "what gets shown" gate.
  const colors = rebalanceCoverage(
    initialClusters
      .sort((left, right) => right.pixelCount - left.pixelCount)
      .map((cluster, index) => ({
        id: `color-${index + 1}`,
        hex: rgbToHex(cluster.rgb),
        rgb: cluster.rgb,
        pixelCount: cluster.pixelCount,
        coveragePercent: 0
      }))
  );

  return {
    width,
    height,
    colors
  };
}

function rebalanceCoverage(colors: PaletteColor[]) {
  const totalPixels = colors.reduce((sum, color) => sum + color.pixelCount, 0);

  return colors.map((color) => ({
    ...color,
    coveragePercent: totalPixels > 0 ? (color.pixelCount / totalPixels) * 100 : 0
  }));
}

function loadImage(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("The image could not be decoded in this browser."));
    image.src = src;
  });
}

function getScaledDimensions(width: number, height: number) {
  const scale = Math.min(1, flattenVizMaxDimension / Math.max(width, height));

  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale))
  };
}

type Cluster = {
  rgb: [number, number, number];
  pixelCount: number;
};

function samplePixels(data: Uint8ClampedArray) {
  const totalPixels = data.length / 4;
  const step = Math.max(1, Math.floor(totalPixels / maxSamplePixels));
  const pixels: [number, number, number][] = [];

  for (let index = 0; index < data.length; index += 4 * step) {
    const alpha = data[index + 3] ?? 0;

    if (alpha < 128) {
      continue;
    }

    pixels.push([data[index] ?? 0, data[index + 1] ?? 0, data[index + 2] ?? 0]);
  }

  return pixels;
}

function bucketPixels(pixels: [number, number, number][]) {
  const buckets = new Map<string, Cluster>();

  for (const pixel of pixels) {
    const quantized: [number, number, number] = [
      quantizeChannel(pixel[0]),
      quantizeChannel(pixel[1]),
      quantizeChannel(pixel[2])
    ];
    const key = quantized.join("-");
    const existing = buckets.get(key);

    if (existing) {
      existing.pixelCount += 1;
      existing.rgb = weightedAverage(existing.rgb, existing.pixelCount - 1, pixel, 1);
      continue;
    }

    buckets.set(key, {
      rgb: pixel,
      pixelCount: 1
    });
  }

  return Array.from(buckets.values());
}

function quantizeChannel(channel: number) {
  return Math.round(channel / 12) * 12;
}

function weightedAverage(
  left: [number, number, number],
  leftWeight: number,
  right: [number, number, number],
  rightWeight: number
): [number, number, number] {
  const totalWeight = leftWeight + rightWeight;

  return [
    Math.round((left[0] * leftWeight + right[0] * rightWeight) / totalWeight),
    Math.round((left[1] * leftWeight + right[1] * rightWeight) / totalWeight),
    Math.round((left[2] * leftWeight + right[2] * rightWeight) / totalWeight)
  ];
}

function rgbToHex([red, green, blue]: [number, number, number]) {
  return `#${[red, green, blue].map((channel) => channel.toString(16).padStart(2, "0")).join("")}`.toUpperCase();
}

const FLUID_OUNCES_PER_GALLON = 128;

function buildGridLinePositions(
  wall: FieldSheetModel["wall"],
  grid: GridSpec
) {
  const vertical: number[] = [];
  const horizontal: number[] = [];

  for (let column = 1; column < grid.columns; column += 1) {
    vertical.push(Math.min(100, (column * grid.cellSizeFt / wall.widthFt) * 100));
  }

  for (let row = 1; row < grid.rows; row += 1) {
    horizontal.push(Math.min(100, (row * grid.cellSizeFt / wall.heightFt) * 100));
  }

  return { vertical, horizontal };
}

function formatPartialGridNotice(grid: GridSpec) {
  if (!grid.hasPartialColumn && !grid.hasPartialRow) {
    return "All cells are full size.";
  }

  const parts: string[] = [];
  if (grid.hasPartialColumn) {
    parts.push(`last column ${roundToTenths(grid.finalColumnWidthFt)} ft wide`);
  }
  if (grid.hasPartialRow) {
    parts.push(`last row ${roundToTenths(grid.finalRowHeightFt)} ft tall`);
  }
  return parts.join("; ");
}

function flattenImageToPalette(
  source: { data: Uint8ClampedArray; width: number; height: number },
  palette: PaletteColor[]
): string | null {
  if (typeof document === "undefined" || palette.length === 0) return null;
  const out = new Uint8ClampedArray(source.data.length);
  // Disabled colors stay in the nearest-match search so their assigned
  // pixels land *somewhere* — we then overwrite those pixels with a
  // diagonal-stripe hatch (#E5E7EB base, #1F2937 stripes, 2-px-wide
  // stripes every 6 px) to convey "skipped region, no paint."
  const HATCH_BASE_R = 229, HATCH_BASE_G = 231, HATCH_BASE_B = 235;
  const HATCH_STROKE_R = 31, HATCH_STROKE_G = 41, HATCH_STROKE_B = 55;
  // sRGB Euclidean is close enough for paint-by-numbers flattening with small
  // palettes and avoids a full Lab conversion per pixel. Perceptual accuracy
  // is not the goal here — showing muralists roughly what their palette will
  // render as is.
  for (let i = 0; i < source.data.length; i += 4) {
    const alpha = source.data[i + 3] ?? 0;
    if (alpha < 128) {
      out[i + 3] = 0;
      continue;
    }
    const r = source.data[i] ?? 0;
    const g = source.data[i + 1] ?? 0;
    const b = source.data[i + 2] ?? 0;
    let bestIndex = 0;
    let bestDistance = Infinity;
    for (let p = 0; p < palette.length; p += 1) {
      const [pr, pg, pb] = palette[p]!.rgb;
      const dr = r - pr;
      const dg = g - pg;
      const db = b - pb;
      const d = dr * dr + dg * dg + db * db;
      if (d < bestDistance) {
        bestDistance = d;
        bestIndex = p;
      }
    }
    const best = palette[bestIndex]!;
    if (best.disabled) {
      const pixelIdx = i >> 2;
      const x = pixelIdx % source.width;
      const y = (pixelIdx - x) / source.width;
      const isStripe = ((x + y) % 6) < 2;
      out[i] = isStripe ? HATCH_STROKE_R : HATCH_BASE_R;
      out[i + 1] = isStripe ? HATCH_STROKE_G : HATCH_BASE_G;
      out[i + 2] = isStripe ? HATCH_STROKE_B : HATCH_BASE_B;
      out[i + 3] = 255;
    } else {
      out[i] = best.rgb[0];
      out[i + 1] = best.rgb[1];
      out[i + 2] = best.rgb[2];
      out[i + 3] = 255;
    }
  }
  const canvas = document.createElement("canvas");
  canvas.width = source.width;
  canvas.height = source.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.putImageData(new ImageData(out, source.width, source.height), 0, 0);
  return canvas.toDataURL("image/png");
}

function formatOunces(requiredGallons: number) {
  const totalOunces = requiredGallons * FLUID_OUNCES_PER_GALLON;
  if (totalOunces >= FLUID_OUNCES_PER_GALLON) {
    return `${requiredGallons.toFixed(2)} gal (${totalOunces.toFixed(0)} oz)`;
  }
  return `${totalOunces.toFixed(1)} oz`;
}

function formatCurrency(amount: number, currency: string) {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amount);
  } catch {
    return `$${amount.toFixed(2)}`;
  }
}

function formatContainerEntry(entry: ContainerPlanEntry) {
  if (entry.unit === "gallon") {
    return `${entry.count} × 1 gal can`;
  }
  if (entry.unit === "quart") {
    return `${entry.count} × 1 qt can`;
  }
  return `${entry.count} × 8 oz sample`;
}

function formatContainerPackages(plan: ColorContainerPlan) {
  const packageLabel = plan.packages.map(formatContainerEntry).join(" + ");
  return `${packageLabel} (${roundToTenths(plan.requiredGallons).toFixed(1)} gal est.)`;
}

function formatContainerTotals(totals: ContainerPlan["totals"]) {
  const parts: string[] = [];
  if (totals.gallons > 0) {
    parts.push(`${totals.gallons} × 1 gal can`);
  }
  if (totals.quarts > 0) {
    parts.push(`${totals.quarts} × 1 qt can`);
  }
  if (totals.samples > 0) {
    parts.push(`${totals.samples} × 8 oz sample`);
  }
  return parts.length > 0 ? parts.join(" + ") : "--";
}

function formatSavedAt(savedAt: string) {
  const timestamp = Date.parse(savedAt);

  if (Number.isNaN(timestamp)) {
    return "recently";
  }

  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(timestamp);
}

function roundToTenths(value: number) {
  return Math.round(value * 10) / 10;
}

function describeMixRecipe(recipe: MixRecipe, palette: PaletteColor[]): string {
  const hexById = new Map(palette.map((color) => [color.id, color.hex]));
  return recipe.components
    .map((component) => {
      const hex = hexById.get(component.colorId) ?? component.colorId;
      const percent = Math.round(component.fraction * 100);
      return `${percent}% ${hex}`;
    })
    .join(" + ");
}

function CloudSaveControls({
  isSignedIn,
  cloudMode,
  paletteColorCount,
  hasSanitizedImage,
  projectName,
  onProjectNameChange,
  cloudSaveStatus,
  onSaveNew,
  onSaveChanges
}: {
  isSignedIn: boolean | null;
  cloudMode: "idle" | "new" | "loaded";
  paletteColorCount: number;
  hasSanitizedImage: boolean;
  projectName: string;
  onProjectNameChange: (next: string) => void;
  cloudSaveStatus: string | null;
  onSaveNew: () => void;
  onSaveChanges: () => void;
}) {
  if (isSignedIn === null) {
    // Still probing the session — render a neutral placeholder so the
    // toolbar layout doesn't jump once auth resolves.
    return (
      <button className="save-button" type="button" disabled aria-busy="true">
        Checking sign-in…
      </button>
    );
  }

  if (!isSignedIn) {
    return (
      <a className="save-button cloud-signin-link" href="/signin?returnTo=/">
        Sign in to save
      </a>
    );
  }

  const saving = cloudSaveStatus === "Saving…";

  if (cloudMode === "loaded") {
    return (
      <button
        className="save-button"
        disabled={saving || paletteColorCount === 0}
        onClick={onSaveChanges}
        type="button"
        title="Save changes to the currently loaded project."
      >
        {saving ? "Saving…" : "Save changes"}
      </button>
    );
  }

  const canSave = paletteColorCount > 0 && hasSanitizedImage;

  return (
    <div className="cloud-save-group">
      <label className="field field-inline cloud-save-name">
        <span>Project name</span>
        <input
          type="text"
          value={projectName}
          onChange={(event) => onProjectNameChange(event.target.value)}
          placeholder="Untitled project"
          maxLength={200}
        />
      </label>
      <button
        className="save-button"
        disabled={!canSave || saving}
        onClick={onSaveNew}
        type="button"
        title="Save this palette and artwork to your Muralist account."
      >
        {saving ? "Saving…" : "Save to my account"}
      </button>
    </div>
  );
}

function ProSettingsPanel({
  open,
  onToggle,
  settings,
  onSettingsChange,
  isSignedIn
}: {
  open: boolean;
  onToggle: () => void;
  settings: ProSettings;
  onSettingsChange: (next: ProSettings) => void;
  isSignedIn: boolean | null;
}) {
  function setSensitivity(next: AutoCombineSensitivity) {
    if (next === "custom") {
      onSettingsChange({ ...settings, autoCombineSensitivity: "custom" });
      return;
    }
    onSettingsChange({
      ...settings,
      autoCombineSensitivity: next,
      residualThreshold: SENSITIVITY_PRESETS[next]
    });
  }

  function setMixCoverage(nextRaw: string) {
    const parsed = Number(nextRaw);
    if (!Number.isFinite(parsed) || parsed < 0) return;
    onSettingsChange({ ...settings, mixCoveragePercent: parsed });
  }

  function setResidual(nextRaw: string) {
    const parsed = Number(nextRaw);
    if (!Number.isFinite(parsed) || parsed <= 0) return;
    onSettingsChange({
      ...settings,
      autoCombineSensitivity: "custom",
      residualThreshold: parsed
    });
  }

  function toggleRemember() {
    onSettingsChange({ ...settings, rememberOnDevice: !settings.rememberOnDevice });
  }

  return (
    <section className="pro-settings-panel" aria-labelledby="pro-settings-heading">
      <header className="pro-settings-header">
        <div>
          <h2 id="pro-settings-heading">Pro settings</h2>
          <p>
            Advanced dials for people who already know how they want the auto-combine and mix math to behave.
          </p>
        </div>
        <button
          className="pro-settings-toggle"
          onClick={onToggle}
          type="button"
          aria-expanded={open}
        >
          {open ? "Hide" : "Show"}
        </button>
      </header>

      {open ? (
        <div className="pro-settings-body">
          <div className="pro-settings-row">
            <div className="pro-settings-row-label">
              <strong>Auto-combine sensitivity</strong>
              <span>
                Higher sensitivity collapses more near-duplicate colors into mixing lines. Lower keeps more distinct buy colors.
              </span>
            </div>
            <div className="sensitivity-preset-group" role="group" aria-label="Auto-combine sensitivity">
              {(["conservative", "balanced", "aggressive", "custom"] as AutoCombineSensitivity[]).map((option) => (
                <button
                  key={option}
                  type="button"
                  className={`sensitivity-preset ${settings.autoCombineSensitivity === option ? "is-active" : ""}`}
                  onClick={() => setSensitivity(option)}
                >
                  {option[0]!.toUpperCase() + option.slice(1)}
                </button>
              ))}
            </div>
          </div>

          {settings.autoCombineSensitivity === "custom" ? (
            <label className="field pro-settings-custom">
              <span>Residual threshold (0-100, RGB units)</span>
              <input
                type="number"
                min="1"
                max="100"
                step="1"
                value={settings.residualThreshold}
                onChange={(event) => setResidual(event.target.value)}
              />
            </label>
          ) : null}

          <div className="pro-settings-row">
            <div className="pro-settings-row-label">
              <strong>Mix coverage threshold</strong>
              <span>
                Colors above this percent of the image stay in the palette as a mix recipe. Below, they dissolve into their nearest neighbor.
              </span>
            </div>
            <label className="field pro-settings-number">
              <span>%</span>
              <input
                type="number"
                min="0"
                max="100"
                step="0.1"
                value={settings.mixCoveragePercent}
                onChange={(event) => setMixCoverage(event.target.value)}
              />
            </label>
          </div>

          {isSignedIn === true ? (
            <p className="pro-settings-sync-note">
              Settings sync to your account.
            </p>
          ) : (
            <label className="pro-settings-remember">
              <input type="checkbox" checked={settings.rememberOnDevice} onChange={toggleRemember} />
              <span>Remember these settings on this device</span>
            </label>
          )}
        </div>
      ) : null}
    </section>
  );
}
