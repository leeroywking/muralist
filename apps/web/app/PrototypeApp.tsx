"use client";

import { ChangeEvent, useRef, useState, useTransition } from "react";

type BrandProfile = {
  id: string;
  name: string;
  retailer: string;
  coverage: number;
  coats: number;
};

type PaletteColor = {
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

const maxDimension = 280;
const maxSamplePixels = 18000;
const initialTarget = 10;
const defaultBrand = brandProfiles[0]!;

export function PrototypeApp() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string>("");
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [targetColors, setTargetColors] = useState(initialTarget);
  const [selectedBrandId, setSelectedBrandId] = useState(defaultBrand.id);
  const [wallArea, setWallArea] = useState("250");
  const [coats, setCoats] = useState(String(defaultBrand.coats));
  const [wastePercent, setWastePercent] = useState("10");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const selectedBrand = brandProfiles.find((brand) => brand.id === selectedBrandId) ?? defaultBrand;
  const parsedArea = Number(wallArea);
  const parsedCoats = Number(coats);
  const parsedWaste = Number(wastePercent) / 100;

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

    startTransition(async () => {
      try {
        const result = await analyzeImage(file, targetColors, canvasRef.current);
        setAnalysis(result);
      } catch (analysisError) {
        setAnalysis(null);
        setError(analysisError instanceof Error ? analysisError.message : "Image analysis failed.");
      }
    });
  }

  function handleTargetChange(nextTarget: number) {
    setTargetColors(nextTarget);

    if (!previewUrl) {
      return;
    }

    const previewImage = new Image();
    previewImage.onload = () => {
      startTransition(async () => {
        try {
          const result = analyzeLoadedImage(previewImage, nextTarget, canvasRef.current);
          setAnalysis(result);
          setError(null);
        } catch (analysisError) {
          setError(analysisError instanceof Error ? analysisError.message : "Image analysis failed.");
        }
      });
    };
    previewImage.src = previewUrl;
  }

  function handleBrandChange(nextBrandId: string) {
    setSelectedBrandId(nextBrandId);
    const nextBrand = brandProfiles.find((brand) => brand.id === nextBrandId);

    if (nextBrand) {
      setCoats(String(nextBrand.coats));
    }
  }

  const estimateReady =
    analysis !== null &&
    Number.isFinite(parsedArea) &&
    parsedArea > 0 &&
    Number.isFinite(parsedCoats) &&
    parsedCoats > 0 &&
    Number.isFinite(parsedWaste) &&
    parsedWaste >= 0;

  return (
    <main className="page-shell">
      <section className="hero hero-grid">
        <div>
          <p className="eyebrow">Working Prototype</p>
          <h1>Muralist</h1>
          <p className="lede">
            Upload a mural image, collapse near-identical shades into a practical
            paint list, and estimate gallons by brand coverage assumptions.
          </p>
          <p className="hero-note">
            This browser prototype intentionally merges close colors so digital
            shading does not explode into an unusable paint list.
          </p>
        </div>
        <div className="hero-panel">
          <div className="metrics">
            <div>
              <span className="metric-label">Palette target</span>
              <strong>{targetColors} colors</strong>
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
            <p>Analyze in the browser. No server round-trip required for this prototype.</p>
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

          <div className="control-stack">
            <label className="field">
              <span>Target palette size</span>
              <input
                type="range"
                min="4"
                max="20"
                value={targetColors}
                onChange={(event) => handleTargetChange(Number(event.target.value))}
              />
            </label>

            <div className="field-inline">
              <span className="field-note">
                Lower values merge harder. Higher values preserve more accents.
              </span>
            </div>
          </div>

          {error ? <p className="status error">{error}</p> : null}
          {isPending ? <p className="status">Analyzing image and merging close shades...</p> : null}

          {previewUrl ? (
            <div className="preview-frame">
              <img alt={fileName || "Uploaded mural preview"} className="preview-image" src={previewUrl} />
              <div className="preview-meta">
                <strong>{fileName}</strong>
                {analysis ? (
                  <span>
                    {analysis.width} × {analysis.height} analyzed
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
            <p>Use rough brand coefficients and wall area to turn color coverage into gallons.</p>
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
              <span>Wall area (sq ft)</span>
              <input
                type="number"
                min="1"
                value={wallArea}
                onChange={(event) => setWallArea(event.target.value)}
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

            <label className="field">
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
              <span className="metric-label">Current coefficient</span>
              <strong>{selectedBrand.coverage} sq ft per gallon</strong>
            </div>
            <div>
              <span className="metric-label">Guest-mode note</span>
              <strong>Calculations are local and unsaved</strong>
            </div>
          </div>
        </section>
      </section>

      <section className="panel results-panel">
        <div className="section-head">
          <h2>3. Reduced Palette</h2>
          <p>
            Similar shades are merged intentionally. Treat these as practical paint choices, not
            a pixel-perfect digital palette.
          </p>
        </div>

        {analysis ? (
          <>
            <div className="summary-strip">
              <div>
                <span className="metric-label">Final colors</span>
                <strong>{analysis.colors.length}</strong>
              </div>
              <div>
                <span className="metric-label">Primary brand</span>
                <strong>{selectedBrand.name}</strong>
              </div>
              <div>
                <span className="metric-label">Estimated total gallons</span>
                <strong>{estimateReady ? formatGallons(getTotalGallons(analysis.colors, parsedArea, parsedCoats, parsedWaste, selectedBrand.coverage)) : "--"}</strong>
              </div>
            </div>

            <div className="palette-grid">
              {analysis.colors.map((color, index) => {
                const estimatedGallons = estimateReady
                  ? getColorGallons(color.coveragePercent, parsedArea, parsedCoats, parsedWaste, selectedBrand.coverage)
                  : null;

                return (
                  <article className="swatch-card" key={`${color.hex}-${index}`}>
                    <div className="swatch" style={{ backgroundColor: color.hex }} />
                    <div className="swatch-body">
                      <div className="swatch-title-row">
                        <strong>{color.hex}</strong>
                        <span>{color.coveragePercent.toFixed(1)}%</span>
                      </div>
                      <p>
                        Approx. {color.pixelCount.toLocaleString()} sampled pixels collapsed into this
                        working color.
                      </p>
                      <div className="estimate-row">
                        <span>{selectedBrand.name}</span>
                        <strong>{estimatedGallons === null ? "--" : formatGallons(estimatedGallons)}</strong>
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          </>
        ) : (
          <div className="empty-results">
            Upload an image to see the reduced palette and per-color paint estimates.
          </div>
        )}
      </section>

      <section className="panel secondary-panel">
        <div className="section-head">
          <h2>Prototype Notes</h2>
          <p>Project docs belong in the repository. The live app stays focused on the workflow.</p>
        </div>
        <ul className="notes-list">
          <li>Color extraction runs locally in the browser with canvas sampling and weighted color merges.</li>
          <li>Brand coverage assumptions are rough planning defaults, not purchase-grade guarantees.</li>
          <li>Signed OAuth and saved libraries are still pending implementation in later rounds.</li>
        </ul>
      </section>

      <canvas className="hidden-canvas" ref={canvasRef} />
    </main>
  );
}

async function analyzeImage(file: File, targetColors: number, canvas: HTMLCanvasElement | null) {
  const imageUrl = URL.createObjectURL(file);

  try {
    const image = await loadImage(imageUrl);
    return analyzeLoadedImage(image, targetColors, canvas);
  } finally {
    URL.revokeObjectURL(imageUrl);
  }
}

function analyzeLoadedImage(image: HTMLImageElement, targetColors: number, canvas: HTMLCanvasElement | null): AnalysisResult {
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
  const reducedClusters = mergeClusters(initialClusters, targetColors);
  const totalPixels = reducedClusters.reduce((sum, cluster) => sum + cluster.pixelCount, 0);

  const colors = reducedClusters
    .sort((left, right) => right.pixelCount - left.pixelCount)
    .map((cluster) => ({
      hex: rgbToHex(cluster.rgb),
      rgb: cluster.rgb,
      pixelCount: cluster.pixelCount,
      coveragePercent: (cluster.pixelCount / totalPixels) * 100
    }));

  return {
    width,
    height,
    colors
  };
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

  return Array.from(buckets.values()).sort((left, right) => right.pixelCount - left.pixelCount);
}

function mergeClusters(clusters: Cluster[], targetColors: number) {
  const working = clusters.slice(0, Math.max(targetColors * 6, targetColors));
  const threshold = getMergeThreshold(targetColors);

  let merged = true;
  while (merged) {
    merged = false;

    for (let leftIndex = 0; leftIndex < working.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < working.length; rightIndex += 1) {
        const leftCluster = working[leftIndex]!;
        const rightCluster = working[rightIndex]!;
        const distance = colorDistance(leftCluster.rgb, rightCluster.rgb);
        const lowCoverageBias = Math.min(6, 100 / Math.max(rightCluster.pixelCount, 1));

        if (distance <= threshold + lowCoverageBias) {
          working[leftIndex] = {
            rgb: weightedAverage(
              leftCluster.rgb,
              leftCluster.pixelCount,
              rightCluster.rgb,
              rightCluster.pixelCount
            ),
            pixelCount: leftCluster.pixelCount + rightCluster.pixelCount
          };
          working.splice(rightIndex, 1);
          merged = true;
          break;
        }
      }

      if (merged) {
        break;
      }
    }
  }

  while (working.length > targetColors) {
    let bestLeft = 0;
    let bestRight = 1;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (let leftIndex = 0; leftIndex < working.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < working.length; rightIndex += 1) {
        const leftCluster = working[leftIndex]!;
        const rightCluster = working[rightIndex]!;
        const distance = colorDistance(leftCluster.rgb, rightCluster.rgb);

        if (distance < bestDistance) {
          bestDistance = distance;
          bestLeft = leftIndex;
          bestRight = rightIndex;
        }
      }
    }

    const leftCluster = working[bestLeft]!;
    const rightCluster = working[bestRight]!;

    working[bestLeft] = {
      rgb: weightedAverage(
        leftCluster.rgb,
        leftCluster.pixelCount,
        rightCluster.rgb,
        rightCluster.pixelCount
      ),
      pixelCount: leftCluster.pixelCount + rightCluster.pixelCount
    };
    working.splice(bestRight, 1);
  }

  return working;
}

function quantizeChannel(channel: number) {
  return Math.round(channel / 16) * 16;
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

function colorDistance(left: [number, number, number], right: [number, number, number]) {
  const rMean = (left[0] + right[0]) / 2;
  const r = left[0] - right[0];
  const g = left[1] - right[1];
  const b = left[2] - right[2];

  return Math.sqrt((2 + rMean / 256) * r * r + 4 * g * g + (2 + (255 - rMean) / 256) * b * b);
}

function getMergeThreshold(targetColors: number) {
  if (targetColors <= 6) {
    return 38;
  }

  if (targetColors <= 10) {
    return 30;
  }

  if (targetColors <= 14) {
    return 24;
  }

  return 20;
}

function rgbToHex([red, green, blue]: [number, number, number]) {
  return `#${[red, green, blue].map((channel) => channel.toString(16).padStart(2, "0")).join("")}`.toUpperCase();
}

function getColorGallons(
  coveragePercent: number,
  areaSqFt: number,
  coats: number,
  wasteFactor: number,
  coverageSqFtPerGallon: number
) {
  const adjustedArea = areaSqFt * (coveragePercent / 100);
  return roundToTenths((adjustedArea * coats * (1 + wasteFactor)) / coverageSqFtPerGallon);
}

function getTotalGallons(
  colors: PaletteColor[],
  areaSqFt: number,
  coats: number,
  wasteFactor: number,
  coverageSqFtPerGallon: number
) {
  return roundToTenths(
    colors.reduce((sum, color) => {
      return sum + getColorGallons(color.coveragePercent, areaSqFt, coats, wasteFactor, coverageSqFtPerGallon);
    }, 0)
  );
}

function roundToTenths(value: number) {
  return Math.round(value * 10) / 10;
}

function formatGallons(value: number) {
  return `${value.toFixed(1)} gal`;
}
