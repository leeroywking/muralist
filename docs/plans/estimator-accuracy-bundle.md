# Plan: Estimator Accuracy Bundle (C + E + G)

**Summary:** Add per-color finish override (C), per-color minimum-container rule (E), and cost-aware qt→gal rounding threshold (G) to the paint estimator, with the math landing in `packages/core` and the existing web prototype wired up to call it.

## 1. Step-by-step plan (file paths)

### Phase 1 — `packages/config` (schema + catalog extensions)

1. `packages/config/src/index.ts`
   - Extend `PaintBrandProfile` with:
     - `prices: { currency: "USD"; quart: number; gallon: number }` — flat per brand for now; finish-specific pricing is deferred (see §5).
     - `finishes: Array<{ id: string; display_name: string; coverage_multiplier: number }>` — ordered; first entry is the default.
   - Extend `PaintBrandCatalog.units` with `price: "usd_per_unit"`.
   - Extend `validateCatalog`:
     - Every brand must have `prices.quart > 0` and `prices.gallon > 0`.
     - Every brand must have `finishes.length >= 1`, unique `id`s, every `coverage_multiplier > 0`.
2. `config/paint-brands.yaml`
   - Add `prices:` block to each of the three existing brands. Seed with researched values at implementation time; if unpublished, use rough market averages and cite source URLs in the existing `sources:` array. Must satisfy the G rounding fixture shape (see §4).
   - Add `finishes:` to each brand. Seed with `matte`, `eggshell`, `satin`, `semigloss` with rough coverage multipliers (e.g. flat/matte ≈ 1.0, eggshell ≈ 0.97, satin ≈ 0.95, semigloss ≈ 0.92). Cite sources where known.
3. `packages/config/test/index.test.ts`
   - Assert prices parse and pass validation for all brands.
   - Assert every brand exposes at least one finish with a positive multiplier.
   - Assert the validator rejects a brand with `prices.quart <= 0`, and a brand with an empty `finishes` array. (Use fixture objects passed to an exported validator — if `validateCatalog` stays private, expose a test-only seam or use a throwaway yaml fixture loaded through `loadPaintBrandCatalog` with a temp path.)

### Phase 2 — `packages/core` (pure math for C coverage, E min-container, G rounding)

4. `packages/core/src/index.ts`
   - Extend `EstimateInput` with optional `finishId?: string`. If omitted, use the brand's first listed finish.
   - Extend `EstimateResult` with `finishId: string` and `coverageMultiplier: number`.
   - Update `estimatePaintRequirement` to resolve finish → multiplier → apply to `brand.coverage.default` before the gallon math. Throw on unknown `finishId`.
   - Add new exported types:
     - `ColorCoverage = { id: string; coveragePercent: number; finishId?: string }`
     - `ContainerPlanEntry = { unit: "gallon" | "quart"; count: number }`
     - `ColorContainerPlan = { colorId: string; finishId: string; requiredGallons: number; packages: ContainerPlanEntry[] }`
     - `ContainerPlan = { perColor: ColorContainerPlan[]; totals: { gallons: number; quarts: number } }`
   - Add new exported function:
     - `suggestContainersForColors(input: { brandId: string; areaSqFt: number; coats?: number; wasteFactor?: number; defaultFinishId?: string; colors: ColorCoverage[] }, catalog: PaintBrandCatalog): ContainerPlan`
     - For each color: compute required gallons using finish-adjusted coverage; enforce **E** (minimum one container per color — at least 1 quart); apply **G** (if required fractional part packed as `k` quarts has `k * qt_price >= gallon_price`, replace with one gallon). Totals are the element-wise sum of per-color packages; **never** collapse colors across containers.
   - Keep the existing `estimatePaintRequirement` in place for single-color API compatibility.
5. `packages/core/test/index.test.ts`
   - Add tests:
     - **C**: given two colors with different `finishId`, the returned `requiredGallons` differ in the direction implied by `coverage_multiplier`.
     - **C (default)**: if `finishId` is omitted, the brand's first listed finish is used.
     - **E**: given 6 colors each with 1% coverage on a small wall (trivial coverage), `perColor.length === 6` and each `packages` contains at least 1 unit.
     - **E (total)**: `totals.quarts + totals.gallons * 4 >= N` where N = number of colors.
     - **G (no round-up)**: using a brand fixture where `qt_price * 4 < gallon_price`, a color needing ≈1 gal worth of paint returns packages containing quarts, not a gallon.
     - **G (round-up)**: using a brand fixture where `qt_price * 3 >= gallon_price`, a color needing ≈0.75 gal returns `{ unit: "gallon", count: 1 }` rather than 3 quarts.
     - Unknown `finishId` throws.
   - Test fixtures: for G, do **not** rely on seeded yaml prices alone. Construct two inline `PaintBrandCatalog`-shaped fixtures (one where qts are cheap, one where they're expensive relative to gallons) and pass them directly to `suggestContainersForColors` so the rule is exercised regardless of real-world price drift.

### Phase 3 — `apps/web` (wire UI to new core, add Finish controls)

6. `apps/web/app/PrototypeApp.tsx`
   - Extend local types:
     - Add `finishId: string` to `PaletteColor` (optional — defaults resolved at render).
     - Add top-level state `defaultFinishId: string`.
     - Add `colorFinishOverrides: Record<string, string>` state (map colorId → finishId).
     - Extend `SavedMergePlan` with `defaultFinishId` and `colorFinishOverrides` (append, do not rename existing fields — backward-compatible read path).
   - Replace the hardcoded `brandProfiles: BrandProfile[]` with catalog data. Two acceptable shapes — pick the smaller:
     - (Preferred) Load the catalog once at module init via a server action / generated JSON at build time; hydrate the client. If that's heavier than appropriate, fall back to a hand-mirrored const synced with the yaml, with a comment pointing at the yaml as the source of truth.
   - Add a **Finish** `<select>` in the "2. Estimate Paint" section beneath the Brand select. Options come from the selected brand's `finishes`.
   - In the "3. Paint Palette" section, on each color chip / row, render a small finish selector (dropdown or segmented control) that defaults to the global `defaultFinishId` but can be overridden per color. Show the effective finish on the chip.
   - Replace the inline `getColorCanPlan` / `getTotalCanPlan` / `buildCanPlan` call sites with one call to the new `suggestContainersForColors` from `@muralist/core`, passing the per-color finish overrides. Keep the old inline functions only if they're still referenced elsewhere; if they become dead after this, flag them and remove in a follow-up (scope discipline — not this PR).
   - Persist new fields via the existing `savedMergePlanKey` localStorage write. Back-compat: on read, default missing `defaultFinishId` / `colorFinishOverrides` to empty.
7. `apps/web/app/styles.css`
   - Add minimal styling for the new Finish selector on chips. Do not restyle existing elements.

### Phase 4 — `apps/mobile`

8. **No code changes in this bundle.**
   - `apps/mobile/App.tsx` is a landing screen today; there is no estimator UI to attach Finish to. Attempting mobile parity now would require building a full estimator surface, which is out of scope. See §5 follow-up.

### Phase 5 — `apps/api`

9. **No code changes in this bundle.**
   - `apps/api/src/{index,server}.ts` do not currently host an estimator route. Adding one is out of scope; when added later, it should consume `suggestContainersForColors` from `@muralist/core` directly.

## 2. AGENTS.md flags

| Flag | Applies? | How the plan handles it |
|---|---|---|
| Guest-mode boundary (`session.kind === "user"` on writes) | **Indirect.** No server-side write path is introduced. Saved palette still writes to `localStorage` only. | No guest gate needed *yet*. When DynamoDB-backed saved palettes land, the extended `SavedMergePlan` shape must be written behind the user-only gate; the new fields (`defaultFinishId`, `colorFinishOverrides`) are single-item attributes that fit the planned single-item access pattern. Calling this out here so the future PR doesn't silently widen the boundary. |
| CORS / new public origins | No | No network surface touched. |
| OAuth tokens in client storage | No | N/A. |
| DynamoDB-first (no relational joins) | Yes — shape of the palette record | Finish overrides modeled as a map attribute on the palette item (`colorFinishOverrides: Record<colorId, finishId>`), not a separate joined entity. Stays single-item. |
| New public endpoint w/o validation or rate limiting | No | No new endpoint. |
| Upload validation | No | No upload code touched. |
| Committed user-scoped brand data | No | Additions to `config/paint-brands.yaml` are **global defaults**, not user-scoped data. Future per-user price/finish overrides still belong in a datastore — do not add them to yaml. |
| `packages/core` purity | Yes | All new math is pure, no I/O. Catalog is passed in. |
| `packages/config` validation | Yes | Validator extended for prices and finishes; tests cover reject cases. |
| Hands-off files (`.github/workflows/**`, root/workspace `package.json`, `tsconfig*.json`, `apps/web/next.config.mjs` basePath, Expo/RN/Next/Fastify versions) | None touched | Plan adds no dependencies and no script changes. |
| Append-only docs / worklog | Yes | This file is a new plan in `docs/plans/`. `worklog.md` will get a **new entry** for this session, not an edit. |

## 3. Ambiguity check

Ambiguity check: none meaningful. The triage Q&A resolved the behaviors the plan depends on. Two small scope calls made here rather than left ambiguous, flagged explicitly so you can overturn them:

- **Finish affects coverage only in this bundle; price-by-finish is deferred.** The brand-level `prices.{quart,gallon}` is flat across finishes for now. The user's note hinted at per-finish cost variation; building that now would balloon the schema and the tests. It slots in later as an optional `prices_by_finish` map without breaking existing data.
- **Mobile parity for C is deferred.** There is no estimator UI on mobile today; adding one is a much larger project than Finish itself. Flagged for a follow-up under the "mobile-first going forward" direction.

## 4. Verification approach

Commands (run from repo root):

- `npm run typecheck` — confirms the new `packages/core` exports, the `packages/config` schema widening, and the web type extensions compile.
- `npm run test` — must exercise the new config validator rejections (phase 1) **and** every test in §5 (phase 2). `typecheck` and `test` already build `@muralist/config` and `@muralist/core` first, so no manual pre-build.
- `npm run build` — confirms the web static export still produces output with the new UI.
- `npm run lint` — confirms no new lint regressions in the changed files.

Manual checks on the Pages preview after the branch PR opens:

- In "2. Estimate Paint", Finish dropdown appears under Brand; changing it changes the estimated total.
- In "3. Paint Palette", each color chip has a Finish selector defaulting to the global selection; changing one chip's finish changes only that color's suggested quantity.
- Merge 6 distinct colors on a small wall; confirm at least 6 containers are suggested in the total.
- Pick a brand where the price math should round up to a gallon early (constructed fixture or real one); confirm the suggestion flips from multiple quarts to one gallon at the threshold.
- Refresh the page after saving; confirm the Finish selections persist via the existing localStorage path.

If any manual check cannot actually be performed (e.g. sandbox can't run the web dev server), say so explicitly in the PR rather than claim success. Definition of shipped: green CI + live Pages preview URL loads the new behavior (`gh pr checks`).

## 5. Open questions

1. **Seed prices in yaml — research values or placeholder?** Implementation will want rough real market values for Sherwin-Williams, Valspar, and Behr at both quart and gallon. If official pricing isn't publicly published, is it acceptable to use a representative retail snapshot and cite the retailer product page in `sources:`?
2. **Finish list — which four?** Plan assumes `matte`, `eggshell`, `satin`, `semigloss`. Confirm or adjust (e.g. add `flat`, drop `eggshell`). Coverage multipliers will need a real source; if none is available per-brand, a single industry-average set applied to all brands is fine for round one.
3. **Catalog consumption path in `apps/web` (Phase 3, step 6).** Two acceptable shapes listed there. Prefer the build-time hydration? Or accept the hand-mirrored const with a TODO?
4. **Scope creep check on C.** The per-color Finish selector is UI work with nontrivial layout implications on narrow viewports. If this bundle starts trending oversized, is F (merge-anchor visual indicator) okay to split *off* from the same PR so C+E+G can land?
5. **Follow-up ticket for mobile estimator.** Should I pre-write the triage brief for "bring estimator surface to `apps/mobile`" so it's queued behind this bundle, or leave that as your call?

## 6. Decisions (answers to §5 open questions)

1. **Seed prices from public retailer snapshots and cite** in each brand's existing `sources:` list. If a given SKU has no public price (e.g. Sherwin-Williams contractor pricing), use the nearest retailer-listed equivalent and cite that SKU explicitly.
2. **Finishes list = whatever each manufacturer publishes** for its primary interior latex line. Expected to be per-brand arrays, not a single global enum — the yaml schema already supports this. Each finish entry cites its source page. Product-line selection: use each brand's current mid-tier interior paint line (SW ProClassic / Valspar Signature / Behr Premium Plus or their current equivalents at implementation time); pick one line per brand, cite it, don't mix.
3. **Build-time catalog hydration** in `apps/web` — preferred. Add a TODO alongside the hydration code noting a desired automatic periodic refresh (quarterly cadence suggested by product owner, appropriate for coverage/price/finish drift — not a new-color cadence, which is a different concern). No CI or scripts work in this bundle for the refresh itself.
4. **Do not split.** C + E + G stays as one PR. Total file touch: `packages/config/src/index.ts`, `config/paint-brands.yaml`, `packages/config/test/index.test.ts`, `packages/core/src/index.ts`, `packages/core/test/index.test.ts`, `apps/web/app/PrototypeApp.tsx`, `apps/web/app/styles.css` — 7 files, all additive, no cross-boundary refactor. Reviewing one Pages preview with all three behaviors together is more useful than three sequential previews.
5. **Mobile estimator triage brief** will be produced as a queued follow-up (separate output, not part of this plan's implementation).

## 7. Scope addendum: D folded in (8 oz sample size)

**2026-04-14:** After the C + E + G PR went up for review, user pointed out that sample-size support (originally slated as separate bundle D) was missing from the estimator. Given the scope was small and the UX feedback was clear, D was folded into the same PR rather than shipped as a follow-up. No plan re-approval needed — the original plan listed D as the next queued bundle, and the user directed that it be added.

**Behavior shipped:**
- `PaintBrandPrices.sample` added (required, validated > 0). All three seeded brands now include a snapshot sample price with `as_of: "2026-04"`.
- `ContainerPlanEntry.unit` accepts `"sample"` in addition to `"gallon"` / `"quart"`.
- `ContainerPlan.totals` gains a `samples` field alongside `gallons` / `quarts`.
- `suggestContainersForColors` picks samples for **detail colors** — specifically, colors whose required paint volume fits in a single 8 oz sample **and** whose sample price is cheaper than a quart. Mid / large colors continue to use the existing quart / gallon E + G math unchanged.
- Sample coverage is implicit (brand `coverage.default` × 1/16 by volume fraction) — no separate `sample_coverage_sqft` field needed, per yaml comment.
- Web formatter renders `"N × 8 oz sample"` in both per-chip and total displays.
- New core tests cover: detail color → 1 sample; sample regime skipped when sample ≥ quart price; 6 detail colors → 6 samples (no container sharing).

**Kept out of this scope extension:** per-finish sample pricing (finish still affects coverage only), and automated refresh of sample prices (quarterly refresh TODO already covers all price fields).

## 8. Scope addendum: per-color coats override + printer-friendly view

**2026-04-14 (same session, follow-up user feedback):** After reviewing the live preview for bundle C + E + G + D, user reported three remaining gaps. One was D (already folded in above). The other two are folded in here:

### Per-color coats override

- **Why:** User flagged that the global Coats field didn't let them vary coats per color — e.g. a dark accent over a light wall needs more coats than the neighbouring field color.
- **What shipped:**
  - `ColorCoverage` gains optional `coats?: number`.
  - `ColorContainerPlan` now reports the effective `coats` used, making the per-color decision visible.
  - `suggestContainersForColors` applies per-color coats in the gallon math; throws on zero or negative coats.
  - Web palette chip gains a small numeric `Coats` input next to the per-chip Finish selector; defaults to the global Coats value, override clears when set back to default.
  - `SavedMergePlan` extended with `colorCoatsOverrides?: Record<string, number>` (back-compat read). Saved / restored alongside finish overrides.
  - Overrides cleared on brand change, new image upload, and pruned on merge.
- **Tests:** `packages/core` gains "per-color coats override changes required gallons" and "zero or negative coats throws".

### Printer-friendly view (bundle B)

- **Why:** User needs a store-ready sheet with the design preview + color list + suggested quantities, printable on white.
- **What shipped:**
  - A "Print / Save PDF" button next to Save Merge Choices. Triggers `window.print()`.
  - `@media print` CSS that hides upload zone, hero, merge toolbar, mix planner, selection strip, swatch toggles, finish / coats inputs, canvas, and all decorative chrome.
  - Preview image and palette grid stay; background forced to white; per-chip card kept with swatch, hex, coverage %, finish + coats (via estimate row text), and suggested container plan.
  - "Save as PDF" is the browser's built-in print destination — no new JS dependency added.
- **Why no `jspdf` or similar:** Adding a client-side PDF library would cross AGENTS.md "Dependency versions ... are their own task" for a feature the browser already supports natively via print-to-PDF. The CSS approach produces the same artifact with zero dependency surface.
- **Kept out:** Per-color price sub-totals, per-store formatting, palette color names (user hasn't assigned names yet in this prototype). Those are independently-scoped follow-ups.
