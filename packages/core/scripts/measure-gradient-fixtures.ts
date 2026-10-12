/**
 * Partner-selection quality under crowding.
 *
 * Puts every gradient from test/fixtures/color-mix-samples.csv into ONE
 * palette (shared hexes deduped, pixels summed; endpoints 3000 px, interior
 * steps 600 px) and classifies it at each auto-combine preset with
 * mixCoveragePercent 0. In isolation every interior step mixes from its own
 * two endpoints (see the CSV fixture test); here every other gradient's
 * colors compete as partners, so the counts show how often the classifier
 * still picks the right pair versus a cross-gradient pair that merely fits
 * under the threshold. Not a test — the numbers are tracked, not asserted.
 *
 * Run from the repo root: npx tsx packages/core/scripts/measure-gradient-fixtures.ts
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { classifyPaletteColors } from "../src/index.js";
import type { ClassifyPaletteInput } from "../src/index.js";

const PRESETS = [0.02, 0.04, 0.07];
const EXAMPLES_PER_PRESET = 4;

type Gradient = { name: string; hexes: string[] };

// Same format as the fixture test: rows 1-2 are headers, columns 1-6 hold
// the six hex steps, the last column the name; incomplete rows are skipped.
function loadGradients(): Gradient[] {
  const csv = readFileSync(
    fileURLToPath(new URL("../test/fixtures/color-mix-samples.csv", import.meta.url)),
    "utf8"
  );
  const gradients: Gradient[] = [];
  for (const line of csv.split(/\r?\n/).slice(2)) {
    const cells = line.split(",").map((cell) => cell.trim());
    const hexes = cells.slice(0, 6);
    if (!hexes.every((hex) => /^#[0-9A-Fa-f]{6}$/.test(hex))) continue;
    gradients.push({ name: cells[cells.length - 1] ?? "", hexes: hexes.map((hex) => hex.toUpperCase()) });
  }
  return gradients;
}

function hexToRgb(hex: string): [number, number, number] {
  return [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16)) as [
    number,
    number,
    number
  ];
}

const gradients = loadGradients();
const pixelsById = new Map<string, number>();
const gradientsByHex = new Map<string, Set<string>>();
const interior: { hex: string; gradient: Gradient }[] = [];
for (const gradient of gradients) {
  gradient.hexes.forEach((hex, index) => {
    const isEndpoint = index === 0 || index === gradient.hexes.length - 1;
    pixelsById.set(hex, (pixelsById.get(hex) ?? 0) + (isEndpoint ? 3000 : 600));
    if (!gradientsByHex.has(hex)) gradientsByHex.set(hex, new Set());
    gradientsByHex.get(hex)!.add(gradient.name);
    if (!isEndpoint) interior.push({ hex, gradient });
  });
}
const palette: ClassifyPaletteInput[] = [...pixelsById].map(([hex, pixelCount]) => ({
  id: hex,
  rgb: hexToRgb(hex),
  pixelCount
}));

console.log(
  `${gradients.length} gradients, ${palette.length} distinct colors, ${interior.length} interior steps`
);
for (const residualThreshold of PRESETS) {
  const byId = new Map(
    classifyPaletteColors(palette, { residualThreshold, mixCoveragePercent: 0 }).map((entry) => [
      entry.id,
      entry
    ])
  );
  let own = 0;
  let cross = 0;
  let buy = 0;
  let absorbed = 0;
  const examples: string[] = [];
  for (const { hex, gradient } of interior) {
    const entry = byId.get(hex)!;
    if (entry.classification === "buy") buy += 1;
    else if (entry.classification === "absorb") absorbed += 1;
    else {
      const partners = entry.recipe!.components;
      if (partners.every((component) => gradient.hexes.includes(component.colorId))) own += 1;
      else {
        cross += 1;
        if (examples.length < EXAMPLES_PER_PRESET) {
          const recipe = partners
            .map(
              (component) =>
                `${Math.round(component.fraction * 100)}% ${component.colorId} (${[
                  ...gradientsByHex.get(component.colorId)!
                ].join(" / ")})`
            )
            .join(" + ");
          examples.push(`    ${hex} (${gradient.name}) = ${recipe}`);
        }
      }
    }
  }
  console.log(
    `preset ${residualThreshold}: interior ${interior.length}, own-gradient mix ${own}, ` +
      `cross-gradient mix ${cross}, buy ${buy}, absorbed ${absorbed}`
  );
  for (const example of examples) console.log(example);
}
