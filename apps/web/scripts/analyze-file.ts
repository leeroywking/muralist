// Dev-only: run the exact production analysis pipeline (apps/web/app/
// imageAnalysis.ts -> @muralist/core) on a local file and print the palette,
// so it can be compared byte-for-byte with what the app shows in any browser.
//
//   npx tsx apps/web/scripts/analyze-file.ts <image> [--json]
//
// Not a package.json script on purpose. Build @muralist/core first
// (`npm run build --workspace @muralist/core`).

import { readFileSync } from "node:fs";
import { analyzeImageBytes, provideWebpWasmModule } from "../app/imageAnalysis";

async function main() {
  const args = process.argv.slice(2);
  const path = args.find((arg) => !arg.startsWith("--"));
  if (!path) {
    console.error("usage: npx tsx apps/web/scripts/analyze-file.ts <image> [--json]");
    process.exit(2);
  }
  // Node can't fetch the libwebp .wasm from a file: URL; hand it over.
  provideWebpWasmModule(
    await WebAssembly.compile(readFileSync(require.resolve("@jsquash/webp/codec/dec/webp_dec.wasm")))
  );
  const bytes = new Uint8Array(readFileSync(path));
  const result = await analyzeImageBytes(bytes, "survey");
  const colors = result.survey?.colors ?? [];
  if (args.includes("--json")) {
    console.log(
      JSON.stringify({
        format: result.format,
        color: result.color.status,
        size: [result.pixels.width, result.pixels.height],
        palette: colors.map((color) => ({ hex: color.hex, coverage: color.coveragePercent.toFixed(1) }))
      })
    );
    return;
  }
  console.log(
    `${path}: ${result.format}, ${result.sourceWidth}x${result.sourceHeight} -> ${result.pixels.width}x${result.pixels.height}, ` +
      `color ${result.color.status}${result.color.profileDescription ? ` (${result.color.profileDescription})` : ""}, ` +
      `decode ${result.timingsMs.decode.toFixed(0)} ms, prepare+survey ${result.timingsMs.prepare.toFixed(0)} ms`
  );
  if (result.color.note) console.log(`note: ${result.color.note}`);
  for (const color of colors) {
    console.log(`${color.hex}  ${color.coveragePercent.toFixed(1)}%`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
