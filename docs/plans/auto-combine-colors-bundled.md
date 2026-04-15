# Auto-Combine Colors (Bundled) — Plan

Task summary: Ship gradient-aware palette classification (**Buy / Mix / Absorb**) end-to-end in one PR — classifier in `packages/core`, web palette UI, `Pro settings` toggle with a configurable mix threshold and sensitivity, PDF mix-recipe workspace, and coverage-absorption math that keeps the paint budget correct when Buy colors have to carry Mix colors' area.

Supersedes `docs/plans/auto-combine-colors.md` (target-count approach) and `docs/plans/auto-combine-colors-classification.md` (two-PR split). User review directed bundled scope and a Pro settings pattern for advanced dials.

## 1. Step-By-Step Plan

### `packages/core`

1. Add exported types to `packages/core/src/index.ts`:
   - `PaletteClassification = "buy" | "mix" | "absorb"`.
   - `MixComponent = { colorId: string; fraction: number }` (fractions sum to 1.0).
   - `MixRecipe = { targetColorId: string; components: MixComponent[] }`.
   - `ClassifiedColor = { id: string; classification: PaletteClassification; absorbedIntoId?: string; recipe?: MixRecipe }`.
   - `ClassifyPaletteInput = { id: string; rgb: [number, number, number]; pixelCount: number }`.
   - `ClassifyPaletteOptions = { residualThreshold: number; mixCoveragePercent: number }` — JSDoc defaults `residualThreshold = 18`, `mixCoveragePercent = 5`.
   - `WorkspaceContent = { kind: "blank" } | { kind: "mixes"; mixes: MixRecipe[] }` — PDF workspace discriminated union, future-proofed for `{ kind: "instructions"; steps: MixStep[] }`.

2. Add `classifyPaletteColors(colors, options)` to `packages/core/src/index.ts`:
   - Compute total pixelCount → per-color coverage %.
   - Process colors in descending coverage order so dominant colors lock as `buy` before smaller ones are tested against them.
   - For each candidate `C`, scan all ordered pairs `(A, B)` of other palette members. Compute `t = dot(C - A, B - A) / dot(B - A, B - A)`. Only consider pairs where `t ∈ [0, 1]` and both endpoints are already `buy`. Measure residual `‖C - ((1-t)·A + t·B)‖`. Keep the pair with the smallest residual.
   - Decision:
     - Best residual > `residualThreshold` → `buy`.
     - Else if `coverage(C) >= mixCoveragePercent` → `mix`, recipe `{ targetColorId: C.id, components: [{A.id, 1 - t}, {B.id, t}] }`.
     - Else → `absorb`, `absorbedIntoId = t < 0.5 ? A.id : B.id`.
   - Tie-break deterministically on equal residual: prefer the pair with higher combined coverage; then lexicographic `A.id` then `B.id`.
   - Degenerate cases: `colors.length < 3` → every color `buy`. If the first pass classifies every color as mix/absorb (impossible given the "endpoints must be buy" rule, but double-check), promote the highest-coverage color to `buy`.

3. Add `applyClassification(colors, classifications)` to `packages/core/src/index.ts`:
   - Returns `{ nextColors, mixes, absorbedCount }`.
   - `absorb`: fold the color's pixelCount into the keeper (`absorbedIntoId`), drop from output.
   - `mix`: keep in output unchanged, append its recipe to `mixes[]`.
   - `buy`: keep unchanged.

4. Add `applyMixesToCoverage(colors, mixes)` to `packages/core/src/index.ts`:
   - Pure function; does not touch `suggestContainersForColors` signature.
   - Takes `ColorCoverage[]` and `MixRecipe[]`.
   - For each Mix recipe with target color `M` of coverage `C_M`, add `fraction · C_M` to each component's coverage. Remove `M` from the output.
   - Returns the adjusted `ColorCoverage[]`.
   - Throws on unknown component ids, mismatched totals, or fractions that do not sum within a small epsilon of 1.0.

5. Add tests to `packages/core/test/index.test.ts`:
   - `classifyPaletteColors`:
     - 10-step red→blue gradient with uniform coverage → `buy = [red, blue]`, every middle step `absorb`.
     - Same gradient + one middle purple bumped to 30% coverage → purple `mix` with recipe ≈ (red 0.5, blue 0.5); other middle steps still `absorb`.
     - Three independent primaries (R, G, B) → all `buy`.
     - Unique accent at <5%, not collinear with any pair → `buy`.
     - 2-color palette → both `buy`, no mixes.
     - Throws on `residualThreshold <= 0`, `mixCoveragePercent < 0`.
   - `applyClassification`: absorbed pixelCounts flow into keepers; mixes list populated; palette order preserved.
   - `applyMixesToCoverage`: a mix redistributes coverage correctly; the mix's own entry is removed; unknown component id throws; `C_total` after redistribution equals `C_total` before, within epsilon.

### `apps/web`

6. Extend core imports in `apps/web/app/PrototypeApp.tsx` to include `classifyPaletteColors`, `applyClassification`, `applyMixesToCoverage`, `MixRecipe`, `WorkspaceContent`, `PaletteClassification`.

7. Add Pro settings state in `apps/web/app/PrototypeApp.tsx`:
   - `const [showProSettings, setShowProSettings] = useState(false)`.
   - `const [proSettings, setProSettings] = useState<ProSettings>(DEFAULT_PRO_SETTINGS)`.
   - `ProSettings = { autoCombineSensitivity: "conservative" | "balanced" | "aggressive" | "custom"; residualThreshold: number; mixCoveragePercent: number; rememberOnDevice: boolean }`.
   - Defaults: `{ autoCombineSensitivity: "balanced", residualThreshold: 18, mixCoveragePercent: 5, rememberOnDevice: true }`.
   - `const SENSITIVITY_PRESETS = { conservative: 10, balanced: 18, aggressive: 28 }`.
   - Preset buttons set `residualThreshold` via the map; `custom` allows the user to drag the raw number.

8. Add Pro settings panel UI near the top of `apps/web/app/PrototypeApp.tsx`:
   - Toggle button with label `Pro settings` next to the hero header. Expanded state shows a card with:
     - Auto-combine sensitivity: four buttons (Conservative / Balanced / Aggressive / Custom). Custom exposes `residualThreshold` as a number input.
     - Mix coverage threshold: number input `%` with help text `Colors above this % of the image stay in the palette as mixes; below they dissolve into their neighbors.`
     - Remember on this device: checkbox.
   - Collapsible via CSS / conditional render.

9. Add Pro settings persistence in `apps/web/app/PrototypeApp.tsx`:
   - Separate `localStorage` key `muralist.pro-settings`.
   - Save on change when `rememberOnDevice` is true; clear the key when it flips false.
   - Hydrate on mount, same pattern as `savedMergePlanKey`.

10. Add classifier state to `apps/web/app/PrototypeApp.tsx`:
    - `const [classifications, setClassifications] = useState<Record<string, PaletteClassification>>({})`.
    - `const [mixRecipes, setMixRecipes] = useState<MixRecipe[]>([])`.

11. Add `handleAutoCombine` next to `mergeSelectedColors`:
    - Build classifier input from `paletteColors`, call `classifyPaletteColors` with `{ residualThreshold: proSettings.residualThreshold, mixCoveragePercent: proSettings.mixCoveragePercent }`.
    - Call `applyClassification`, then `rebalanceCoverage` on `nextColors`.
    - Update `paletteColors`, `classifications`, `mixRecipes`, prune `colorFinishOverrides` / `colorCoatsOverrides` for dropped ids.
    - Reset `selectedColorIds` / `mergeKeeperId`.
    - Set `saveMessage` to `Kept N colors to buy, flagged M to mix, absorbed K gradient colors.` (or `Nothing to auto-combine.`).

12. Add the `Auto-combine similar colors` button to the merge toolbar in `apps/web/app/PrototypeApp.tsx`:
    - Next to `Merge Selected`, reuses `.save-button` className.
    - `disabled={paletteColors.length < 3}`.

13. Palette chip UI updates in `apps/web/app/PrototypeApp.tsx`:
    - `.swatch-card` variant per classification: `mix` chips get a visible `mix` badge and a recipe line `mix ≈ {pctA}% {hexA} + {pctB}% {hexB}`.
    - `buy` chips render as today.
    - Absorbed colors are already gone from the palette — nothing to render.

14. Extend `FieldSheetModel` in `apps/web/app/PrototypeApp.tsx`:
    - Add `workspace: WorkspaceContent`.
    - Populate as `{ kind: "mixes", mixes: mixRecipes }` when `mixRecipes.length > 0`, else `{ kind: "blank" }`.
    - Add `buyColors` and `mixColors` projections for the PDF (or decorate `colors[]` with classification). Plan uses two arrays because the PDF renders them in different surfaces.

15. Fix the paint-budget math in `apps/web/app/PrototypeApp.tsx`:
    - Before calling `suggestContainersForColors`, run `applyMixesToCoverage(paletteColorsAsCoverage, mixRecipes)` so Buy colors carry the Mix colors' area.
    - The resulting `ContainerPlan` has Buy entries only. Mix colors are displayed separately with the `mix` badge and no package line.

16. Include `classifications`, `mixRecipes`, and (if remembered) `proSettings` in `SavedMergePlan`. Defensive restore — treat missing fields as empty / defaults.

17. Styling in `apps/web/app/styles.css`:
    - `.pro-settings-panel` layout.
    - `.sensitivity-preset-group` for the four buttons.
    - `.swatch-card-mix` accent (border color + corner badge).
    - `.mix-recipe-line` small-type treatment.

### `apps/web/app/maquettePdf.ts`

18. Extend the PDF to consume `FieldSheetModel.workspace`:
    - Replace the current `drawWorkspace(...)` call with a dispatch on `model.workspace.kind`.
    - `"blank"` → current guide-line renderer (unchanged).
    - `"mixes"` → new `drawMixRecipes(page, fonts, workspace.mixes, buyColors, bounds)`:
      - One stacked row per recipe: target color swatch, `=`, component swatches with percentages.
      - Fonts and sizing match existing swatch column.
      - Layout cap: if mix count exceeds the workspace height at the minimum row height, truncate with a `…and N more` line — the PDF stays single-page for the default case.
    - Unknown kinds fall through to `"blank"`.

19. PDF swatch column (`drawSwatchTable`) in `apps/web/app/maquettePdf.ts`:
    - Render Buy colors with package + cost as today.
    - Render Mix colors with a `mix` badge in place of the package label, and a ratio line `{pctA}% {hexA} + {pctB}% {hexB}`. No cost line for Mix colors.

20. Totals card (`drawNotesAndTotals`) in `apps/web/app/maquettePdf.ts`:
    - Reflects the re-allocated coverage (Buy colors' effective sq ft has grown), so the total package label already captures the full paint budget. No separate Mix cost line.
    - Adjust the "N colors" footnote to read `N to buy, M to mix`.

### Not touched

- `apps/api/**`, `apps/mobile/**`, `packages/config/**`, `config/paint-brands.yaml`.
- `.github/workflows/**`, root and workspace `package.json` scripts, `tsconfig*.json`, `apps/web/next.config.mjs`.
- `suggestContainersForColors` signature — `applyMixesToCoverage` is a pre-pipeline transform, not a contract change.

## 2. AGENTS.md Flag Check

- Guest-mode persistent write boundary: **N/A**. Pro settings and classifier state live in browser `localStorage`; no server write paths added.
- CORS widening: **N/A**.
- OAuth provider tokens: **N/A**.
- DynamoDB-first modeling: **N/A**.
- New public endpoint / rate limiting: **N/A**.
- Upload validation: **N/A** — operates on in-memory palette after the existing upload gate.
- Committed user-scoped data: **N/A** — no generated palettes, mixes, or Pro settings committed. Do not commit any sample output PDF or classifier output.
- `packages/core` purity: **applies**. `classifyPaletteColors`, `applyClassification`, `applyMixesToCoverage` must stay I/O-free. Plan honors this: pure math, web-agnostic input types, deterministic tie-breaking.
- Hands-off surfaces (CI, scripts, tsconfig, next.config basePath): **not touched**.

## 3. Ambiguity Check

Two meaningful ambiguities:

**Ambiguity A — color space** (RGB vs OKLab):
- Option A (chosen for v1): RGB distance. Matches user framing, no new helpers, cheap.
- Option B: OKLab. More perceptually accurate. Reserved for a follow-up Pro setting so this PR stays reviewable.
- Decision: build Option A; Pro panel lists "color space" as a future dropdown, not wired yet.

**Ambiguity B — coverage pool** (what area the Mix color adds to the Buy budget):
- Option A (chosen): Mix coverage redistributes by the recipe fractions. If Mix M is 10% coverage with recipe (A 0.4, B 0.6), Buy A gains 4% and Buy B gains 6%.
- Option B: Mix coverage divides evenly regardless of recipe. Simpler to explain, but over-buys the minor component and under-buys the major one.
- Decision: Option A. Matches painting reality — the recipe's fractions are the mix proportions, and the muralist will consume paint in those proportions.

No user-visible "build both to compare" variants — these are single-right-answer choices that the PR text should explain, not two previews to surface.

Already-answered ambiguities from review (captured for the PR trail):

- **Bundled, not split.** User prefers one PR because the PDF is the star and the web view is a supporting verification surface.
- **Pro settings is a panel at the top** of the page, collapsible, with presets for sensitivity and a raw number for Custom.
- **Pro settings persistence** is user-controlled via the `Remember on this device` checkbox.
- **Mix threshold default 5%**, sensitivity default "Balanced" (residual 18).
- **Two-component mixes only** — `MixRecipe.components[]` is an array for future three-component support without a breaking change.

## 4. Verification Approach

Run from repo root after implementation:

- `npm run typecheck`
- `npm run test`
- `npm run build`
- `npm run lint`

Manual on the Pages preview once CI finishes:

- Upload `docs/example_art/winding-path-9840681_640.jpg` and run the full flow.
- Default (Pro settings closed): click `Auto-combine similar colors`. Status line reports `Kept N to buy, flagged M to mix, absorbed K`. Palette shows Buy chips unchanged and Mix chips with a `mix` badge + recipe line.
- Open Pro settings, flip sensitivity through Conservative / Balanced / Aggressive; confirm the palette responds each time (more `buy` at Conservative, more collapse at Aggressive).
- Raise `Mix coverage threshold` to 15%; confirm several Mix colors reclassify as Absorb and disappear from the palette.
- `Save Merge Choices`, reload the page, `Restore Saved Palette`: classifications, mix recipes, and Pro settings all restore (when `Remember on this device` is on).
- Uncheck `Remember on this device`: reload, confirm defaults apply.
- `Download Maquette PDF`. Verify:
  - Single page for the common case (a mural image with ≤10 Buy colors and a handful of Mix colors).
  - Left workspace shows mix recipes: target swatch `=` component swatches with percentages.
  - Right swatch column shows Buy colors with packages + cost, Mix colors with `mix` badge and ratio line (no cost).
  - Totals card reflects Buy-only purchase totals; footnote reads `N to buy, M to mix`.
  - No regression on the single-page layout for low Mix counts.
- Rerun the Playwright harness at `~/.local/share/playwright-tools/exercise-maquette.mjs`, confirm the downloaded PDF still loads as one page.

## 5. Open Questions

1. **Sensitivity presets — naming and values.** `Conservative / Balanced / Aggressive` with residuals `10 / 18 / 28`. Are those labels clear to muralists? Is `18` the right Balanced default, or should we calibrate after a preview pass on real artwork? Plan ships the current values and flags for calibration.
2. **Future Pro settings** — is the candidate list (OKLab color space, PDF page size, show/hide costs, max colors on page one, blank-workspace override) the right shortlist? Plan defers implementation but reserves panel space.
3. **Degenerate fallback** — if no Buy color remains after classification (should be unreachable given the `endpoints must be buy` rule, but worth a belt-and-braces test), promote the highest-coverage color to Buy. Confirm this is the right fallback.
4. **Mix badge copy** — `mix`, `mix this`, or the full recipe on the chip? Plan uses a short `mix` badge + recipe line under hex.
5. **Workspace overflow in PDF** — if there are many Mix recipes, truncate with `…and N more` to preserve the single-page promise. Alternative: overflow to page 2. Plan truncates; flag if you'd rather overflow.
