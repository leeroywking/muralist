# Auto-Combine Colors via Buy/Mix/Absorb Classification — Plan

Task summary: Replace the fixed-target-count auto-combine design with a gradient-aware classifier that sorts every palette color into **Buy**, **Mix**, or **Absorb** using collinearity in RGB space weighted by coverage %. Ship in two PRs: (1) classifier + palette state + future-proofed `FieldSheetModel.workspace` extension point, and (2) PDF workspace renderer + coverage-absorption math.

Supersedes `docs/plans/auto-combine-colors.md` after user review — the target-count approach was too blunt and did not handle the user's red/blue/purple case.

## 1. Step-By-Step Plan

### PR 1: Classifier, palette state, extension point

#### `packages/core`

1. Add exported types to `packages/core/src/index.ts`:
   - `PaletteClassification = "buy" | "mix" | "absorb"`.
   - `MixComponent = { colorId: string; fraction: number }` (fractions sum to 1.0).
   - `MixRecipe = { targetColorId: string; components: MixComponent[] }`.
   - `ClassifiedColor = { id: string; classification: PaletteClassification; absorbedIntoId?: string; recipe?: MixRecipe }`.
   - `ClassifyPaletteInput = { id: string; rgb: [number, number, number]; pixelCount: number }` (web-agnostic).
   - `ClassifyPaletteOptions = { residualThreshold: number; mixCoveragePercent: number }` with defaults documented in JSDoc: `residualThreshold = 18`, `mixCoveragePercent = 5`.
   - `WorkspaceContent = { kind: "blank" } | { kind: "mixes"; mixes: MixRecipe[] }` — the discriminated union the PDF will read. Future variants (`kind: "instructions"`) land without breaking callers.

2. Add `classifyPaletteColors(colors, options)` to `packages/core/src/index.ts`:
   - Compute total pixelCount → per-color coverage %.
   - Iterate: for each color `C`, scan all ordered pairs `(A, B)` of remaining palette members (`A ≠ B ≠ C`) and compute `t = dot(C - A, B - A) / dot(B - A, B - A)`. If `t ∈ [0, 1]`, measure residual `‖C - ((1-t)·A + t·B)‖`. Pick the pair with the smallest residual. Skip pairs where the endpoints are already marked `absorb` — mixes should only reference `buy` colors.
   - If the best residual > `residualThreshold` → `C.classification = "buy"`.
   - Else if `coverage(C) >= mixCoveragePercent` → `C.classification = "mix"`, `recipe = { targetColorId: C.id, components: [{colorId: A.id, fraction: 1-t}, {colorId: B.id, fraction: t}] }`.
   - Else → `C.classification = "absorb"`, `absorbedIntoId = (t < 0.5 ? A.id : B.id)`.
   - Process highest-coverage colors first so dominant colors are locked as `buy` before smaller ones are classified against them.
   - Deterministic tie-break on equal residual: prefer the pair with higher combined coverage (a mix built from major colors is more useful than one built from two minor ones).
   - Guard: if `colors.length < 3`, every color is `buy` (no pair exists). If all endpoints get classified as mix/absorb such that no `buy` remains, degrade gracefully by marking the highest-coverage color in each gradient chain as `buy`.

3. Add `applyClassification(colors, classifications)` to `packages/core/src/index.ts`:
   - Returns `{ nextColors, mixes, absorbedCount }`.
   - For each `absorb`: fold the absorbed color's pixelCount into the keeper (`absorbedIntoId`) and drop the color from the output.
   - For each `mix`: keep the color in the output unchanged (coverage math for the workspace happens in PR 2) and append its recipe to `mixes[]`.
   - For each `buy`: keep unchanged.
   - Call site can then feed `nextColors` through the existing `rebalanceCoverage` path.

4. Add tests to `packages/core/test/index.test.ts`:
   - A 10-step red-to-blue gradient with coverage evenly distributed → classifier returns `buy: [red, blue]`, every middle step `absorb` (since each middle step is <5% individually).
   - Same gradient but with one middle purple bumped to 30% coverage → purple becomes `mix` with recipe ~(red 0.5, blue 0.5) and two components referencing red/blue ids.
   - Three perceptually independent primaries (R, G, B), none on a shared line → all three stay `buy`.
   - Unique accent at <5% coverage that is not collinear with any pair → stays `buy` (residual too high to be a mix or absorb).
   - Degenerate case: palette of 2 colors → both `buy`, no mixes.
   - `applyClassification`: absorbed pixelCount flows to the keeper; mixes list is populated; palette order preserved by remaining entries.
   - Throws on `residualThreshold <= 0` or `mixCoveragePercent < 0`.

#### `apps/web`

5. Extend the core import block in `apps/web/app/PrototypeApp.tsx` to include `classifyPaletteColors`, `applyClassification`, `MixRecipe`, `WorkspaceContent`.

6. Add state alongside the existing palette state in `apps/web/app/PrototypeApp.tsx`:
   - `const [classifications, setClassifications] = useState<Record<string, PaletteClassification>>({})`.
   - `const [mixRecipes, setMixRecipes] = useState<MixRecipe[]>([])`.

7. Add `handleAutoCombine` near `mergeSelectedColors`:
   - Build classifier input from `paletteColors`, call `classifyPaletteColors`.
   - Call `applyClassification`, then `rebalanceCoverage` on `nextColors`.
   - Update `paletteColors`, `classifications`, `mixRecipes`, and prune `colorFinishOverrides` / `colorCoatsOverrides` for dropped ids (same pattern as `mergeSelectedColors`).
   - Reset `selectedColorIds` / `mergeKeeperId`.
   - Set `saveMessage` to `Kept N colors to buy, flagged M to mix, absorbed K gradient colors.` — or `Nothing to auto-combine.` when all three counters are zero.

8. Add an `Auto-combine similar colors` button in the merge toolbar in `PrototypeApp.tsx`:
   - Next to `Merge Selected`, reuses `.save-button` className.
   - `disabled={paletteColors.length < 3}`.

9. Palette chip UI in `PrototypeApp.tsx`:
   - Add a small classification badge to each `.swatch-card` when a classification exists: `buy` (no badge, neutral), `mix` (badge text `mix`, accent styling), `absorb` never visible because absorbed colors are dropped from `paletteColors`.
   - For `mix` chips, append a compact recipe line under the hex: `mix · A{hex}·(1−t) + B{hex}·t` or a friendlier `mix ≈ 50/50 {hex}+{hex}`.

10. Extend `FieldSheetModel` in `apps/web/app/PrototypeApp.tsx`:
    - Add `workspace: WorkspaceContent`.
    - Populate as `{ kind: "blank" }` in PR 1 (even when mixes exist) — the renderer in PR 2 flips this to `{ kind: "mixes", mixes: mixRecipes }`.
    - Exporting `FieldSheetModel` still via the existing `export type` already on the file.

11. Include `mixRecipes` and `classifications` in `SavedMergePlan` in `apps/web/app/PrototypeApp.tsx` so save/restore round-trips the classifier state. Migrate missing fields defensively in `restoreSavedChoices` (treat undefined as `buy` for every color).

12. Styling in `apps/web/app/styles.css`:
    - `.swatch-card-mix` accent (border color and small corner badge) so mix chips are visually distinct from buy chips.
    - No new button styles required.

#### Not touched in PR 1

- `apps/web/app/maquettePdf.ts` — still reads `fieldSheetModel` the same way. `workspace.kind === "blank"` keeps current behavior.
- `apps/api/**`, `apps/mobile/**`, `packages/config/**`, `config/paint-brands.yaml`.
- `.github/workflows/**`, root and workspace `package.json` scripts, `tsconfig*.json`, `apps/web/next.config.mjs`.

### PR 2: PDF workspace renderer + coverage-absorption math

Planned but not implemented in this PR. Captured here so PR 1's data model is shaped correctly:

- In `apps/web/app/PrototypeApp.tsx`, populate `fieldSheetModel.workspace = { kind: "mixes", mixes: mixRecipes }` when recipes exist; fall back to `{ kind: "blank" }` when empty.
- For each Mix color `M` with coverage `C_M` and recipe, **re-allocate** coverage: add `fraction · C_M` to each component's effective coverage *before* calling `suggestContainersForColors`. Mix colors themselves contribute zero purchase cost. This is the correctness fix flagged above — without it, the paint budget under-counts.
- In `apps/web/app/maquettePdf.ts`, replace the blank workspace renderer with a dispatch on `workspace.kind`. `"mixes"` renders a stacked list of mix recipes: target swatch, "=", component swatches with ratios. `"blank"` keeps today's guide lines. Unknown kinds fall through to blank.
- PDF swatch column shows Mix colors with a `mix` badge instead of a package label; totals reflect the re-allocated coverage of the Buy colors.

## 2. AGENTS.md Flag Check

- Guest-mode persistent write boundary: **N/A**. Classifier state saves to `localStorage` under the existing `SavedMergePlan` path — same guest-safe surface used today.
- CORS widening: **N/A**.
- OAuth provider tokens: **N/A**.
- DynamoDB-first modeling: **N/A**.
- New public endpoint / rate limiting: **N/A**.
- Upload validation: **N/A**.
- Committed user-scoped data: **N/A** — do not commit generated palettes, mixes, or example outputs.
- `packages/core` purity: **applies**. `classifyPaletteColors` and `applyClassification` must stay I/O-free — no DOM, no canvas, no network. Plan uses web-agnostic input types and deterministic math.
- Hands-off surfaces (CI, scripts, tsconfig, next.config basePath): **not touched**.

## 3. Ambiguity Check

Meaningful ambiguity: **color space for the collinearity test — RGB vs OKLab**.

- Option A (chosen for v1): RGB distance. Matches how the user framed the problem ("distance in rgb"), no dependency on a color-conversion helper, cheap. Residual threshold `18` per channel tested on typical mural photos.
- Option B: convert each rgb to OKLab, run the same math there. More perceptually uniform so mis-grouping rare colors is less likely. Adds a `rgbToOkLab` helper to `packages/core` but no heavy deps. Not required for v1; can be a later PR if the RGB default mis-classifies colors on the example art.

Building Option A for PR 1. If the Pages preview shows RGB mis-grouping on `docs/example_art/winding-path-9840681_640.jpg` I'll flag it and OKLab becomes PR 1.5.

Already-answered ambiguities from review (captured for the PR trail):

- **No target-count cap.** Output size is data-driven. A complex image keeps more buy colors; a gradient-heavy image collapses hard.
- **Mix threshold:** coverage ≥ 5% flips a collinear color from `absorb` to `mix`. 5% is the user's suggested number.
- **Two-component mixes only** in v1. `MixRecipe.components[]` is an array so future PRs can extend to 3-component mixes without a breaking change.
- **Split into two PRs.** PR 1 ships the classifier, UI differentiation, and the `workspace` extension point. PR 2 ships the PDF workspace renderer and the coverage-absorption math.

## 4. Verification Approach

Run from repo root after each PR:

- `npm run typecheck`
- `npm run test`
- `npm run build`
- `npm run lint`

Manual on the Pages preview for PR 1:

- Upload `docs/example_art/winding-path-9840681_640.jpg` — initial palette up to 50 colors.
- Click `Auto-combine similar colors`. Status line reports buy / mix / absorbed counts.
- Visually inspect the palette: buy chips are plain, mix chips carry a mix badge and recipe line. No absorb chips appear (absorbed colors are gone from the palette).
- Manual merge still works on the reduced palette. Finish / coats overrides still work.
- `Save Merge Choices`, reload, `Restore Saved Palette` → classifications and mix recipes restore.
- `Download Maquette PDF` — PDF renders today's layout (workspace still blank in PR 1). Swatch column includes Mix colors alongside Buy colors. No crash, no regression.
- Programmatic sanity from the Playwright harness at `~/.local/share/playwright-tools/exercise-maquette.mjs`: re-run and confirm the downloaded PDF still loads as 1 page for ≤10 buy colors.

Manual on the Pages preview for PR 2 (added when that plan is written):

- Same workflow, plus: open downloaded PDF, confirm the left workspace now lists mix recipes with swatches and ratios, confirm totals reflect re-allocated coverage (Mix colors show no purchase, Buy colors' required gallons increase correspondingly).

## 5. Open Questions

1. **Mix coverage threshold** — `5%` is the user's suggestion. Should it be configurable per image (slider next to the button) or stay a fixed constant for v1? Plan uses a fixed constant.
2. **Mix pinning** — should the user be able to override a classifier decision (e.g. force a colored chip from `mix` back to `buy` because they don't want to mix on-site)? Nice UX, plausibly out of scope for v1. Plan defers.
3. **Which color space wins** if RGB mis-groups on the example art — ship RGB for v1 with a flagged follow-up, or invest the extra file for OKLab up front? Plan ships RGB and flags.
4. **Bundling decision** — if the user prefers one PR over two, collapse the two-PR structure and ship classifier + PDF workspace together. Plan assumes two PRs unless the user says otherwise.
5. **Degenerate fallback** — if the classifier marks every color `mix` or `absorb` (no `buy` remains), the plan promotes the highest-coverage color in each gradient chain back to `buy`. Confirm this is the right fallback vs refusing to classify and showing a warning.
