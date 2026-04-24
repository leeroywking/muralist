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

type PaletteColor = {
  id: string;
  hex: string;
  rgb: [number, number, number];
  pixelCount: number;
  coveragePercent: number;
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

const maxDimension = 320;
const maxSamplePixels = 22000;
const paletteLimit = 50;
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
    const raw = paletteColors.map((color) => ({
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
    const colorAreas = deriveColorAreaEstimates(
      wallArea,
      paletteColors.map((color) => ({
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
      colors: paletteColors.map((color) => {
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

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const saved = window.localStorage.getItem(savedMergePlanKey);

    if (!saved) {
      return;
    }

    try {
      const parsed = JSON.parse(saved) as SavedMergePlan;
      setSavedMergePlan(parsed);
    } catch {
      window.localStorage.removeItem(savedMergePlanKey);
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const saved = window.localStorage.getItem(proSettingsKey);
    if (!saved) return;
    try {
      const parsed = JSON.parse(saved) as Partial<ProSettings>;
      setProSettings({ ...DEFAULT_PRO_SETTINGS, ...parsed });
    } catch {
      window.localStorage.removeItem(proSettingsKey);
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (proSettings.rememberOnDevice) {
      window.localStorage.setItem(proSettingsKey, JSON.stringify(proSettings));
    } else {
      window.localStorage.removeItem(proSettingsKey);
    }
  }, [proSettings]);

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    // TODO(ui-round): wire apps/web/app/uploadPipeline.ts + apiClient.ts
    // to replace this client-only flow with an API-persisting flow.
    const file = event.target.files?.[0];

    if (!file) {
      return;
    }

    if (!file.type.startsWith("image/")) {
      setError("Choose an image file such as PNG, JPG, WEBP, or HEIC.");
      return;
    }

    if (file.size > 15 * 1024 * 1024) {
      setError("Keep uploads under 15 MB for the browser prototype.");
      return;
    }

    const nextPreviewUrl = URL.createObjectURL(file);
    setPreviewUrl(nextPreviewUrl);
    setFileName(file.name);
    setError(null);
    setSaveMessage("");
    setSelectedColorIds([]);
    setMergeKeeperId("");
    setColorFinishOverrides({});
    setColorCoatsOverrides({});
    setFlattenedImageUrl(null);
    sourcePixelsRef.current = null;

    startTransition(async () => {
      try {
        const result = await analyzeImage(file, canvasRef.current);
        setSourceAnalysis(result);
        setPaletteColors(result.colors);
        const canvas = canvasRef.current;
        const ctx = canvas?.getContext("2d", { willReadFrequently: true });
        if (canvas && ctx) {
          const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
          sourcePixelsRef.current = { data: new Uint8ClampedArray(img.data), width: canvas.width, height: canvas.height };
        }
      } catch (analysisError) {
        setSourceAnalysis(null);
        setPaletteColors([]);
        setError(analysisError instanceof Error ? analysisError.message : "Image analysis failed.");
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
    if (paletteColors.length < 3) {
      setSaveMessage("Need at least three captured colors before auto-combine can help.");
      return;
    }

    const classifierInput = paletteColors.map((color) => ({
      id: color.id,
      rgb: color.rgb,
      pixelCount: color.pixelCount
    }));

    const classifiedList = classifyPaletteColors(classifierInput, {
      residualThreshold: proSettings.residualThreshold,
      mixCoveragePercent: proSettings.mixCoveragePercent
    });
    const { nextColors, mixes, absorbedCount } = applyClassification(classifierInput, classifiedList);

    if (absorbedCount === 0 && mixes.length === 0) {
      setSaveMessage("Nothing to auto-combine — no gradient or mix members detected.");
      return;
    }

    const pixelCountById = new Map(nextColors.map((entry) => [entry.id, entry.pixelCount]));
    const nextPalette: PaletteColor[] = paletteColors
      .filter((color) => pixelCountById.has(color.id))
      .map((color) => ({ ...color, pixelCount: pixelCountById.get(color.id)! }))
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
              <strong>Top {paletteLimit} colors max</strong>
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
                {savedMergePlan ? (
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
                  title="Classify the palette into colors to buy, colors to mix, and gradient members to absorb into their nearest neighbors."
                >
                  Auto-combine similar colors
                </button>
                <button
                  className="save-button"
                  disabled={paletteColors.length === 0}
                  onClick={saveMergedChoices}
                  type="button"
                >
                  Save Merge Choices
                </button>
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
                {savedMergePlan ? (
                  <button className="restore-button" onClick={restoreSavedChoices} type="button">
                    Restore Saved Palette
                  </button>
                ) : null}
              </div>
            </div>

            {saveMessage ? <p className="status">{saveMessage}</p> : null}
            {pdfError ? <p className="status error">{pdfError}</p> : null}

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

            <div className="palette-grid">
              {paletteColors.map((color) => {
                const isSelected = selectedColorIds.includes(color.id);
                const colorPlan = planByColorId.get(color.id) ?? null;
                const effectiveFinishId = colorFinishOverrides[color.id] ?? defaultFinishId;
                const classification = classifications[color.id] ?? "buy";
                const isMix = classification === "mix";
                const recipe = isMix ? mixRecipes.find((entry) => entry.targetColorId === color.id) : undefined;

                return (
                  <article
                    className={`swatch-card ${isSelected ? "swatch-card-selected" : ""} ${isMix ? "swatch-card-mix" : ""}`}
                    key={color.id}
                  >
                    <button
                      className="swatch-toggle"
                      onClick={() => toggleColorSelection(color.id)}
                      type="button"
                    >
                      <div className="swatch" style={{ backgroundColor: color.hex }} />
                    </button>
                    <div className="swatch-body">
                      <div className="swatch-title-row">
                        <strong>{color.hex}</strong>
                        <span>{color.coveragePercent.toFixed(1)}%</span>
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
                        />
                      </label>
                      <div className="estimate-row">
                        <span>{selectedBrand.display_name}</span>
                        <strong>{colorPlan ? formatContainerPackages(colorPlan) : "--"}</strong>
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
  onArtistNotesChange
}: {
  model: FieldSheetModel;
  originalImageUrl: string | null;
  reducedImageUrl: string | null;
  onArtistNotesChange: (notes: string) => void;
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
          />
          <GridPreview
            aspectRatio={wallAspectRatio}
            gridLines={gridLines}
            imageFit="fill"
            imageUrl={reducedImageUrl}
            label="Reduced mural preview"
            note="Fit to entered wall dimensions. Grid cells represent real-world spacing."
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
  note
}: {
  aspectRatio: number;
  gridLines: { vertical: number[]; horizontal: number[] };
  imageFit: "contain" | "fill";
  imageUrl: string | null;
  label: string;
  note: string;
}) {
  return (
    <figure className="grid-preview">
      <div className="grid-preview-frame" style={{ aspectRatio }}>
        {imageUrl ? (
          <img
            alt={label}
            className={`grid-preview-image grid-preview-image-${imageFit}`}
            src={imageUrl}
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

  const { width, height } = getScaledDimensions(image.naturalWidth, image.naturalHeight);
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
  const colors = rebalanceCoverage(
    initialClusters
      .sort((left, right) => right.pixelCount - left.pixelCount)
      .slice(0, paletteLimit)
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
  const scale = Math.min(1, maxDimension / Math.max(width, height));

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
    const rgb = palette[bestIndex]!.rgb;
    out[i] = rgb[0];
    out[i + 1] = rgb[1];
    out[i + 2] = rgb[2];
    out[i + 3] = 255;
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

function ProSettingsPanel({
  open,
  onToggle,
  settings,
  onSettingsChange
}: {
  open: boolean;
  onToggle: () => void;
  settings: ProSettings;
  onSettingsChange: (next: ProSettings) => void;
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

          <label className="pro-settings-remember">
            <input type="checkbox" checked={settings.rememberOnDevice} onChange={toggleRemember} />
            <span>Remember these settings on this device</span>
          </label>
        </div>
      ) : null}
    </section>
  );
}
