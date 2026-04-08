"use client";

import { ChangeEvent, useEffect, useMemo, useRef, useState, useTransition } from "react";

type BrandProfile = {
  id: string;
  name: string;
  retailer: string;
  coverage: number;
  coats: number;
};

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

type SavedMergePlan = {
  savedAt: string;
  fileName: string;
  selectedBrandId: string;
  wallLength: string;
  wallWidth: string;
  coats: string;
  wastePercent: string;
  sourceAnalysis: AnalysisResult | null;
  paletteColors: PaletteColor[];
};

type CanBreakdown = {
  gallons: number;
  label: string;
  count: number;
};

type MixingBasePaint = {
  id: string;
  name: string;
  rgb: [number, number, number];
};

type MixingRecipe = {
  colorId: string;
  targetHex: string;
  mixHex: string;
  distance: number;
  totalParts: number;
  components: {
    paintId: string;
    paintName: string;
    parts: number;
  }[];
};

type MixingPlan = {
  paletteIds: string[];
  paints: MixingBasePaint[];
  recipes: MixingRecipe[];
  score: number;
};

const brandProfiles: BrandProfile[] = [
  {
    id: "sherwin_williams",
    name: "Sherwin-Williams",
    retailer: "Sherwin-Williams",
    coverage: 375,
    coats: 2
  },
  {
    id: "valspar",
    name: "Valspar",
    retailer: "Lowe's",
    coverage: 400,
    coats: 2
  },
  {
    id: "behr",
    name: "Behr",
    retailer: "Home Depot",
    coverage: 325,
    coats: 2
  }
];

const defaultBrand = brandProfiles[0]!;
const maxDimension = 320;
const maxSamplePixels = 22000;
const paletteLimit = 50;
const savedMergePlanKey = "muralist.saved-merge-plan";
const canSizes: CanBreakdown[] = [
  { gallons: 5, label: "5 gal bucket", count: 0 },
  { gallons: 1, label: "1 gal can", count: 0 },
  { gallons: 0.25, label: "1 qt can", count: 0 }
];
const mixingBasePaints: MixingBasePaint[] = [
  { id: "white", name: "Titanium White", rgb: [244, 242, 236] },
  { id: "black", name: "Carbon Black", rgb: [34, 37, 43] },
  { id: "blue", name: "Ultramarine Blue", rgb: [41, 73, 170] },
  { id: "cyan", name: "Phthalo Blue", rgb: [0, 118, 191] },
  { id: "yellow", name: "Primary Yellow", rgb: [227, 186, 40] },
  { id: "red", name: "Primary Red", rgb: [187, 64, 60] },
  { id: "green", name: "Phthalo Green", rgb: [38, 130, 100] }
];
const maxMixPlanColors = 3;

export function PrototypeApp() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [fileName, setFileName] = useState("");
  const [sourceAnalysis, setSourceAnalysis] = useState<AnalysisResult | null>(null);
  const [paletteColors, setPaletteColors] = useState<PaletteColor[]>([]);
  const [selectedBrandId, setSelectedBrandId] = useState(defaultBrand.id);
  const [wallLength, setWallLength] = useState("25");
  const [wallWidth, setWallWidth] = useState("10");
  const [coats, setCoats] = useState(String(defaultBrand.coats));
  const [wastePercent, setWastePercent] = useState("10");
  const [selectedColorIds, setSelectedColorIds] = useState<string[]>([]);
  const [mergeKeeperId, setMergeKeeperId] = useState<string>("");
  const [savedMergePlan, setSavedMergePlan] = useState<SavedMergePlan | null>(null);
  const [saveMessage, setSaveMessage] = useState("");
  const [mixingPlan, setMixingPlan] = useState<MixingPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const selectedBrand = brandProfiles.find((brand) => brand.id === selectedBrandId) ?? defaultBrand;
  const parsedLength = Number(wallLength);
  const parsedWidth = Number(wallWidth);
  const parsedCoats = Number(coats);
  const parsedWaste = Number(wastePercent) / 100;
  const wallArea = parsedLength * parsedWidth;

  const estimateReady =
    paletteColors.length > 0 &&
    Number.isFinite(parsedLength) &&
    parsedLength > 0 &&
    Number.isFinite(parsedWidth) &&
    parsedWidth > 0 &&
    Number.isFinite(parsedCoats) &&
    parsedCoats > 0 &&
    Number.isFinite(parsedWaste) &&
    parsedWaste >= 0;

  const mergeOptions = useMemo(() => {
    return paletteColors.filter((color) => selectedColorIds.includes(color.id));
  }, [paletteColors, selectedColorIds]);
  const mixTargetColors = useMemo(() => {
    return paletteColors.filter((color) => selectedColorIds.includes(color.id)).slice(0, maxMixPlanColors);
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
      setSavedMergePlan(JSON.parse(saved) as SavedMergePlan);
    } catch {
      window.localStorage.removeItem(savedMergePlanKey);
    }
  }, []);

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
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
    setMixingPlan(null);
    setSelectedColorIds([]);
    setMergeKeeperId("");

    startTransition(async () => {
      try {
        const result = await analyzeImage(file, canvasRef.current);
        setSourceAnalysis(result);
        setPaletteColors(result.colors);
      } catch (analysisError) {
        setSourceAnalysis(null);
        setPaletteColors([]);
        setError(analysisError instanceof Error ? analysisError.message : "Image analysis failed.");
      }
    });
  }

  function handleBrandChange(nextBrandId: string) {
    setSelectedBrandId(nextBrandId);
    const nextBrand = brandProfiles.find((brand) => brand.id === nextBrandId);

    if (nextBrand) {
      setCoats(String(nextBrand.coats));
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
    setSelectedColorIds([]);
    setMergeKeeperId("");
    setSaveMessage("");
    setMixingPlan(null);
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
      coats,
      wastePercent,
      sourceAnalysis,
      paletteColors
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
    setCoats(savedMergePlan.coats);
    setWastePercent(savedMergePlan.wastePercent);
    setSourceAnalysis(savedMergePlan.sourceAnalysis);
    setPaletteColors(savedMergePlan.paletteColors);
    setSelectedColorIds([]);
    setMergeKeeperId("");
    setSaveMessage("Saved merged choices restored.");
    setMixingPlan(null);
  }

  function generateMixingPlan() {
    if (mixTargetColors.length === 0) {
      return;
    }

    setMixingPlan(buildMixingPlan(mixTargetColors));
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
              <strong>{selectedBrand.name}</strong>
            </div>
            <div>
              <span className="metric-label">Coverage</span>
              <strong>{selectedBrand.coverage} sq ft/gal</strong>
            </div>
          </div>
        </div>
      </section>

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
                {brandProfiles.map((brand) => (
                  <option key={brand.id} value={brand.id}>
                    {brand.name} ({brand.retailer})
                  </option>
                ))}
              </select>
            </label>

            <label className="field">
              <span>Length (ft)</span>
              <input
                type="number"
                min="1"
                value={wallLength}
                onChange={(event) => setWallLength(event.target.value)}
              />
            </label>

            <label className="field">
              <span>Width (ft)</span>
              <input
                type="number"
                min="1"
                value={wallWidth}
                onChange={(event) => setWallWidth(event.target.value)}
              />
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
                <span className="metric-label">Mix planner</span>
                <strong>{Math.min(selectedColorIds.length, maxMixPlanColors)} target colors</strong>
              </div>
              <div>
                <span className="metric-label">Estimated total</span>
                <strong>{estimateReady ? formatCanPlan(getTotalCanPlan(paletteColors, wallArea, parsedCoats, parsedWaste, selectedBrand.coverage)) : "--"}</strong>
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
                  className="save-button"
                  disabled={paletteColors.length === 0}
                  onClick={saveMergedChoices}
                  type="button"
                >
                  Save Merge Choices
                </button>
                {savedMergePlan ? (
                  <button className="restore-button" onClick={restoreSavedChoices} type="button">
                    Restore Saved Palette
                  </button>
                ) : null}
                <button
                  className="mix-button"
                  disabled={mixTargetColors.length === 0}
                  onClick={generateMixingPlan}
                  type="button"
                >
                  Find Mix Plan
                </button>
              </div>
            </div>

            {saveMessage ? <p className="status">{saveMessage}</p> : null}

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

            <section className="mix-plan-panel">
              <div className="section-head">
                <h3>4. Mix Planner</h3>
                <p>
                  Select up to {maxMixPlanColors} chips, then generate a shared mixing plan that tries to reduce the
                  number of paints you need to buy.
                </p>
              </div>

              {mixingPlan ? (
                <div className="mix-plan-grid">
                  <article className="mix-plan-card">
                    <strong>Buy These Base Paints</strong>
                    <div className="mix-buy-list">
                      {mixingPlan.paints.map((paint) => (
                        <div className="mix-buy-chip" key={paint.id}>
                          <span className="selected-chip-swatch" style={{ backgroundColor: rgbToHex(paint.rgb) }} />
                          <span>{paint.name}</span>
                        </div>
                      ))}
                    </div>
                    <p className="mix-note">
                      This is a rough studio plan. Start with test batches before scaling up to full cans.
                    </p>
                  </article>

                  {mixingPlan.recipes.map((recipe) => (
                    <article className="mix-plan-card" key={recipe.colorId}>
                      <div className="mix-target-row">
                        <div>
                          <span className="metric-label">Target color</span>
                          <strong>{recipe.targetHex}</strong>
                        </div>
                        <span className="mix-swatch-pair">
                          <span className="mix-swatch" style={{ backgroundColor: recipe.targetHex }} />
                          <span className="mix-swatch" style={{ backgroundColor: recipe.mixHex }} />
                        </span>
                      </div>
                      <p>{formatRecipe(recipe)}</p>
                      <small className="mix-note">
                        Approximate match score: {recipe.distance.toFixed(1)}. Lower is closer.
                      </small>
                    </article>
                  ))}
                </div>
              ) : (
                <div className="empty-selection">
                  Select one to three colors, then use <strong>Find Mix Plan</strong> to generate rough artist-friendly ratios.
                </div>
              )}
            </section>

            <div className="palette-grid">
              {paletteColors.map((color) => {
                const isSelected = selectedColorIds.includes(color.id);
                const canPlan = estimateReady
                  ? getColorCanPlan(color.coveragePercent, wallArea, parsedCoats, parsedWaste, selectedBrand.coverage)
                  : null;

                return (
                  <article className={`swatch-card ${isSelected ? "swatch-card-selected" : ""}`} key={color.id}>
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
                      <p>{color.pixelCount.toLocaleString()} sampled pixels in this working color.</p>
                      <div className="estimate-row">
                        <span>{selectedBrand.name}</span>
                        <strong>{canPlan ? formatCanPlan(canPlan) : "--"}</strong>
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
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

function getColorCanPlan(
  coveragePercent: number,
  areaSqFt: number,
  coats: number,
  wasteFactor: number,
  coverageSqFtPerGallon: number
) {
  const adjustedArea = areaSqFt * (coveragePercent / 100);
  const requiredGallons = (adjustedArea * coats * (1 + wasteFactor)) / coverageSqFtPerGallon;
  return buildCanPlan(requiredGallons);
}

function getTotalCanPlan(
  colors: PaletteColor[],
  areaSqFt: number,
  coats: number,
  wasteFactor: number,
  coverageSqFtPerGallon: number
) {
  const totalGallons = colors.reduce((sum, color) => {
    return sum + (areaSqFt * (color.coveragePercent / 100) * coats * (1 + wasteFactor)) / coverageSqFtPerGallon;
  }, 0);

  return buildCanPlan(totalGallons);
}

function buildCanPlan(requiredGallons: number) {
  const minimumGallons = Math.max(0.25, requiredGallons);
  let remaining = minimumGallons;
  const plan = canSizes.map((size) => ({ ...size }));

  for (const entry of plan) {
    if (entry.gallons === 0.25) {
      entry.count = Math.ceil(remaining / entry.gallons);
      remaining = 0;
      break;
    }

    entry.count = Math.floor(remaining / entry.gallons);
    remaining -= entry.count * entry.gallons;
  }

  if (remaining > 0) {
    plan[plan.length - 1]!.count += 1;
  }

  return {
    requiredGallons: minimumGallons,
    packages: plan.filter((entry) => entry.count > 0)
  };
}

function buildMixingPlan(targetColors: PaletteColor[]) {
  const targetPalette = targetColors.slice(0, maxMixPlanColors);
  const candidateSets = getMixingCandidateSets();
  let bestPlan: MixingPlan | null = null;

  for (const paints of candidateSets) {
    const recipes = targetPalette.map((color) => getBestRecipe(color, paints));
    const totalDistance = recipes.reduce((sum, recipe) => sum + recipe.distance, 0);
    const sharedPaintPenalty = paints.length * 8;
    const componentPenalty = recipes.reduce((sum, recipe) => sum + recipe.components.length, 0) * 0.75;
    const score = totalDistance + sharedPaintPenalty + componentPenalty;

    if (!bestPlan || score < bestPlan.score) {
      bestPlan = {
        paletteIds: targetPalette.map((color) => color.id),
        paints,
        recipes,
        score
      };
    }
  }

  return bestPlan;
}

function getMixingCandidateSets() {
  const paintById = new Map(mixingBasePaints.map((paint) => [paint.id, paint]));
  const candidateIds = [
    ["white", "blue"],
    ["white", "cyan"],
    ["white", "blue", "cyan"],
    ["white", "blue", "black"],
    ["white", "cyan", "black"],
    ["white", "green", "blue"],
    ["white", "yellow", "red"],
    ["white", "yellow", "green"],
    ["white", "red", "blue"],
    ["white", "yellow", "black"],
    ["white", "red", "black"],
    ["white", "green", "black"]
  ];

  return candidateIds.map((ids) => ids.map((id) => paintById.get(id)!));
}

function getBestRecipe(targetColor: PaletteColor, paints: MixingBasePaint[]): MixingRecipe {
  let bestRecipe: MixingRecipe | null = null;

  for (let totalParts = 2; totalParts <= 6; totalParts += 1) {
    for (const parts of getPartsCombos(paints.length, totalParts)) {
      const mixedRgb = mixPaints(paints, parts);
      const distance = getColorDistance(targetColor.rgb, mixedRgb);
      const candidate: MixingRecipe = {
        colorId: targetColor.id,
        targetHex: targetColor.hex,
        mixHex: rgbToHex(mixedRgb),
        distance,
        totalParts,
        components: paints
          .map((paint, index) => ({
            paintId: paint.id,
            paintName: paint.name,
            parts: parts[index] ?? 0
          }))
          .filter((component) => component.parts > 0)
      };

      if (!bestRecipe || candidate.distance < bestRecipe.distance) {
        bestRecipe = candidate;
      }
    }
  }

  return bestRecipe!;
}

function getPartsCombos(length: number, totalParts: number): number[][] {
  const combos: number[][] = [];

  function build(index: number, remaining: number, current: number[]) {
    if (index === length - 1) {
      combos.push([...current, remaining]);
      return;
    }

    for (let value = 1; value <= remaining - (length - index - 1); value += 1) {
      build(index + 1, remaining - value, [...current, value]);
    }
  }

  build(0, totalParts, []);
  return combos;
}

function mixPaints(paints: MixingBasePaint[], parts: number[]) {
  const linear = paints.map((paint) => paint.rgb.map(srgbToLinear) as [number, number, number]);
  const totalParts = parts.reduce((sum, part) => sum + part, 0);

  const mixed = linear.reduce<[number, number, number]>((sum, color, index) => {
    const weight = (parts[index] ?? 0) / totalParts;

    return [
      sum[0] + color[0] * weight,
      sum[1] + color[1] * weight,
      sum[2] + color[2] * weight
    ];
  }, [0, 0, 0]);

  return [
    linearToSrgb(mixed[0]),
    linearToSrgb(mixed[1]),
    linearToSrgb(mixed[2])
  ] as [number, number, number];
}

function getColorDistance(left: [number, number, number], right: [number, number, number]) {
  const leftLab = rgbToLab(left);
  const rightLab = rgbToLab(right);

  return Math.sqrt(
    (leftLab[0] - rightLab[0]) ** 2 +
      (leftLab[1] - rightLab[1]) ** 2 +
      (leftLab[2] - rightLab[2]) ** 2
  );
}

function rgbToLab(rgb: [number, number, number]) {
  const red = srgbToLinear(rgb[0]);
  const green = srgbToLinear(rgb[1]);
  const blue = srgbToLinear(rgb[2]);
  const x = red * 0.4124564 + green * 0.3575761 + blue * 0.1804375;
  const y = red * 0.2126729 + green * 0.7151522 + blue * 0.072175;
  const z = red * 0.0193339 + green * 0.119192 + blue * 0.9503041;

  const normalizedX = x / 0.95047;
  const normalizedY = y / 1;
  const normalizedZ = z / 1.08883;

  const fx = labPivot(normalizedX);
  const fy = labPivot(normalizedY);
  const fz = labPivot(normalizedZ);

  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)] as [number, number, number];
}

function labPivot(value: number) {
  return value > 0.008856 ? Math.cbrt(value) : 7.787 * value + 16 / 116;
}

function srgbToLinear(channel: number) {
  const normalized = channel / 255;
  return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(value: number) {
  const normalized =
    value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055;

  return Math.max(0, Math.min(255, Math.round(normalized * 255)));
}

function formatCanPlan(plan: { requiredGallons: number; packages: CanBreakdown[] }) {
  const packageLabel = plan.packages.map((entry) => `${entry.count} × ${entry.label}`).join(" + ");
  return `${packageLabel} (${roundToTenths(plan.requiredGallons).toFixed(1)} gal est.)`;
}

function formatRecipe(recipe: MixingRecipe) {
  const ratio = recipe.components
    .map((component) => `${component.parts} part${component.parts === 1 ? "" : "s"} ${component.paintName}`)
    .join(", ");

  return `Mix ${ratio} for an approximation near ${recipe.targetHex}.`;
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
