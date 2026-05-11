# Unmerge & Lock Palette Colors — Plan

Task summary: Two related controls for taking back authority from the auto-classifier.

1. **Unmerge.** Per-swatch Inspect button opens a modal listing every raw cluster currently absorbed into that swatch (both Phase 0 dedup and Phase 2 absorbs); user can select clusters and click Unmerge to promote them back to standalone swatches.
2. **Lock.** Per-swatch Lock toggle marks a color as protected from auto-merge. Locked colors cannot be absorbed by Phase 0 dedup or by Phase 2 classification, but they CAN still receive other colors absorbing into them. A user who unmerges a color and wants it to stick across future Auto-combine clicks locks it.

Anchor use case (covers both controls): viking_choir.jpg's brown skin tones absorbed into a dark mauve mix below the 5% coverage threshold. User clicks Inspect on the mauve swatch, sees the warm-tone clusters listed, unmerges them to recover the face as its own palette entry, then locks the new brown swatch so a subsequent Auto-combine click at a different sensitivity can't re-absorb it.

## Background — what "merge" means in this codebase

`classifyPaletteColors` in `packages/core/src/index.ts:444-600` is the merge engine. Two layers produce "absorbed" classifications:

- **Phase 0 — dedupNearestNeighbors** (`packages/core/src/index.ts:602-686`): silently merges any pair within `residualThreshold` Euclidean RGB distance; lower-coverage member absorbs into higher.
- **Phase 2 — interior classification** (`packages/core/src/index.ts:533-567`): for clusters that project onto a mixing line between two buy endpoints with residual ≤ threshold AND coverage < `mixCoveragePercent`, classified as `absorb` with `absorbedIntoId` pointing at one of the two endpoints.

Phase 3 path compression (`packages/core/src/index.ts:584-597`) ensures every absorbed `absorbedIntoId` points directly at a surviving (non-absorb) id. So the merge graph is already flat in the classifier output.

`applyClassification` (`packages/core/src/index.ts:763+`) is the destructive step — it folds absorbed pixel counts into keepers and returns only the kept colors. The current upload-time flow in `PrototypeApp.tsx` discards the raw cluster set after that step runs. **The first thing this plan does is stop discarding it.**

## 1. Step-By-Step Plan

### `packages/core/src/index.ts` — classifier honors a `lockedIds` set

The Unmerge half of this plan does NOT touch core. The Lock half does — the classifier needs to know which inputs are locked so it can skip absorbing them. Modifications:

1. Add an optional `lockedIds?: Set<string>` field to `ClassifyPaletteOptions` (around `packages/core/src/index.ts:140-ish` where the options type lives). Default is an empty set.
2. In `dedupNearestNeighbors` (`packages/core/src/index.ts:602-686`), inside the pair-scoring loop:
    - If both candidates are locked → skip the pair (neither can absorb the other).
    - If exactly one is locked → the locked one is forced as keeper, regardless of which has higher pixelCount.
    - If neither is locked → existing keeper logic (higher pixelCount, then lexicographic id tiebreak).
3. In Phase 2 (`packages/core/src/index.ts:533-567`), when iterating survivors:
    - If a survivor is in `lockedIds` and would otherwise classify as `absorb` (because it lies on a mixing line below the coverage threshold), force it to `buy` instead. The mixing pair info is discarded; the locked color stays standalone.
    - Locked survivors are still eligible to be `mix` if coverage ≥ `mixCoveragePercent` AND they project onto an extremes pair. Mix doesn't *remove* a color from the visible palette, so it doesn't conflict with locking.
4. Add a unit test in `packages/core/test/index.test.ts` covering the Lock semantics. Two scenarios:
    - Locked low-coverage color that would normally absorb: confirm it stays buy.
    - Locked color near an unlocked color within `residualThreshold`: confirm Phase 0 promotes the locked one as keeper even if it has lower pixelCount.

### `apps/api/src/schemas/project.ts` — schema cap bump + lock field

5. At line 52, change `originalColors: z.array(paletteColorSchema).max(200).optional()` → `.max(1000)`. Raw bucket lists at full natural resolution can reach ~800 entries on busy images (viking_choir hit 798). 1000 gives headroom. Wire-size impact is bounded: each entry is ~40-60 bytes JSON, so worst case ~60 KB inside the palette payload — well under the 600k base64 cap on the image artifact.
6. In `paletteColorSchema` (lines 11-16 + the disabled field added in PR #11), add `locked: z.boolean().optional()`. Optional, same pattern as `disabled`. Coverage refine unaffected.

### `apps/api/test/projects.test.ts` — coverage for the larger payload + lock field

7. New test: POST `/projects` with `palette.originalColors` of length 900, each a valid color entry. Assert 201. Confirms the new cap.
8. New test: POST `/projects` with `palette.colors[0].locked = true`. Assert 201 and round-trip via GET. Confirms `locked` accepts boolean and persists.
9. New test: POST `/projects` with `palette.colors[0].locked = "yes"`. Assert 400. Confirms the schema rejects non-boolean.

### `apps/web/app/PrototypeApp.tsx` — type extensions + state

10. Add `locked?: boolean` to the local `PaletteColor` type (alongside the `disabled` field added in PR #11). Same default-false semantics as `disabled`.
11. Add a ref `originalClustersRef = useRef<PaletteColor[] | null>(null)`. A ref is fine since changes don't drive re-renders; only the modal reads it on demand.
12. Add state slot `lastClassifiedOptions: { residualThreshold: number; mixCoveragePercent: number } | null` so the merge-graph recomputation uses the same options that produced the current visible palette. Initial value `null`; set on upload (to `{ residualThreshold: SENSITIVITY_PRESETS.balanced, mixCoveragePercent: proSettings.mixCoveragePercent }`) and on every Auto-combine click (to the values actually passed to `classifyPaletteColors`).

### `apps/web/app/PrototypeApp.tsx` — upload + auto-combine call sites

13. **Upload (current `Promise.all` block):** before classifying, stash `analysis.colors` into `originalClustersRef.current`. Set `lastClassifiedOptions` to `{ residualThreshold: SENSITIVITY_PRESETS.balanced, mixCoveragePercent: proSettings.mixCoveragePercent }`. Pass an empty `lockedIds: new Set()` to `classifyPaletteColors` (no colors locked at upload time).
14. **Auto-combine (`handleAutoCombine`):** filter `enabledColors` (already filtered for `!disabled`) and ALSO derive `lockedIds = new Set(enabledColors.filter(c => c.locked).map(c => c.id))`. Pass `lockedIds` into `classifyPaletteColors`. Update `lastClassifiedOptions` to the values actually passed. Do NOT update `originalClustersRef` — it always reflects the immutable upload-time raw clusters.

### `apps/web/app/PrototypeApp.tsx` — merge-graph computation (pure helper)

15. Add a pure helper `function computeMergeGraph(originalClusters, visibleColors, options): Map<string, Array<{id, hex, rgb, pixelCount}>>`. Implementation: re-run `classifyPaletteColors(originalClusters, { ...options, lockedIds: visibleColors.filter(c => c.locked).map(c => c.id) })`. For each classified entry with `classification === "absorb"` and `absorbedIntoId` in `visibleColors`, append the raw cluster to the keeper's list. Filter out any cluster id that's already present in the current `paletteColors` (so already-unmerged entries don't appear as "still merged into" anything). Sort each list by `pixelCount` desc.
16. Computed on demand only when the user opens the Inspect modal — cost is one extra classify pass (~10-50 ms on a typical raw set; well under any UI threshold). Cache result in a ref keyed by `(visibleSwatchId, lastClassifiedOptions, lockedIdsSnapshot)` if the user re-opens the same modal in the same session — optional, skipped in v1.

### `apps/web/app/PrototypeApp.tsx` — swatch Inspect + Lock affordances + modal

17. **Inspect button.** Adjacent to the existing "Skip in estimate" pill on each swatch card. Small button labeled "Inspect" (or info-icon ⓘ). Click handler calls `openInspect(color.id)`.
18. **Lock toggle.** Adjacent to Skip + Inspect. Small icon button (padlock open / closed). Toggles `color.locked`. Tooltip when unlocked: "Lock this color so Auto-combine won't merge it away." Tooltip when locked: "Unlock — Auto-combine can merge this color again." Visual indication when locked: small padlock icon overlay on the swatch tile + locked-state pill style.
19. **Modal component.** Inline within `PrototypeApp.tsx` for v1 (extract to `apps/web/app/UnmergeModal.tsx` if it grows past ~80 LOC). Props: `keeperColor: PaletteColor`, `mergedClusters: ...[]`, `onUnmerge(ids: string[], lockUnmerged: boolean): void`, `onClose(): void`.
20. **Modal markup.**
    - Header: "Colors merged into [color chip] [hex]"
    - Body: scrollable list of `mergedClusters`. Empty state: "No colors were merged into this one — it stands on its own."
    - Each row: checkbox + color chip + hex + pixel count + "rgb(r,g,b)".
    - Footer: "Unmerge selected" + "Unmerge all" + an inline checkbox "Lock unmerged colors" (default ON — the most common intent is "split this out and make it stick") + Cancel.
    - Backdrop click + Esc closes.
21. **Open-state.** `const [inspectColorId, setInspectColorId] = useState<string | null>(null)`. Modal renders when non-null. `openInspect(id)` sets it; the modal computes `mergedClusters` via the helper from step 15 using `originalClustersRef.current`, `lastClassifiedOptions`, the current `paletteColors`, and the current set of locked ids.

### `apps/web/app/PrototypeApp.tsx` — unmerge action + toggleColorLocked

22. Function `unmergeColors(keeperId: string, clusterIds: string[], lockUnmerged: boolean)`. For each clusterId:
    - Look up the cluster in `originalClustersRef.current` → get hex, rgb, pixelCount.
    - Subtract pixelCount from the keeper's pixelCount in `paletteColors`.
    - Construct a new `PaletteColor` entry from the cluster's hex/rgb/pixelCount; set `locked = lockUnmerged` (true by default per the modal checkbox).
    - Classify it as "buy" in the `classifications` map.
23. After processing all clusterIds, call `rebalanceCoverage` on the new palette and `setPaletteColors`. Update `classifications` state. Leave `mixRecipes` as-is.
24. Close the modal.
25. Function `toggleColorLocked(colorId: string)`. Flips `color.locked` on the matching palette entry. No other state side-effects (unlike toggleColorDisabled, which clears selections — locked colors stay selectable for manual merge, since manual merge respects user intent rather than auto-classifier rules).

### `apps/web/app/PrototypeApp.tsx` — buildEditorSnapshot wiring

31. The `EditorSnapshot.originalPaletteColors` slot already exists at `apps/web/app/editorPersistence.ts:80`. Populate it from `originalClustersRef.current` inside `buildEditorSnapshot()` (find the existing builder around `PrototypeApp.tsx:530+`). When the ref is null (e.g. for a project that loaded without raw clusters — pre-feature project), omit the field.

### `apps/web/app/editorPersistence.ts` — round-trip `locked`

26. `buildPaletteJson` already serializes `palette.originalColors` from `snapshot.originalPaletteColors` (line 139-140). No code change there — works as soon as `PrototypeApp` populates the snapshot field.
27. Extend `EditorPaletteColor` type with `locked?: boolean` (alongside the `disabled` field added in PR #11).
28. In `toBackendPaletteColors`: when `color.locked === true`, emit `backendColor.locked = true`. Omit otherwise.
29. In `toEditorPaletteColors`: when `color.locked === true` on the backend, propagate to the editor color.
30. `hydrateFromProject` (line 256-265) already returns `originalPaletteColors` from `palette.originalColors`. We just need PrototypeApp to consume it on hydration:

### `apps/web/app/PrototypeApp.tsx` — hydration wiring

32. In the project-load path (`PrototypeApp.tsx:580+`, the hydrated branch), populate `originalClustersRef.current = hydrated.originalPaletteColors` (when non-empty). When the array is empty (legacy projects pre-feature), Inspect modal still works but shows the empty state for every swatch — acceptable graceful degradation.
33. Also populate `lastClassifiedOptions` on hydration: default to `{ residualThreshold: SENSITIVITY_PRESETS.balanced, mixCoveragePercent: proSettings.mixCoveragePercent }`. (Sticky persistence of the classify options is a follow-up.)
34. The `locked` field on each color comes through automatically via the persistence round-trip changes (steps 27-29). No additional hydration code needed beyond the existing `hydrated.paletteColors` consumer.

### `apps/web/app/styles.css` — Inspect button + Lock toggle + modal styles

35. `.swatch-inspect-button` — small ghost button, sits in the swatch card alongside `.swatch-skip-pill`.
36. `.swatch-lock-button` — icon button (padlock open / closed glyph or text). When `.is-locked`, slightly darker background to read as "active." When unlocked, ghost style matching the inspect button.
37. `.swatch-locked-overlay` — small padlock badge in the top-right corner of the swatch tile when locked (visible-from-glance indicator).
38. `.unmerge-modal-backdrop`, `.unmerge-modal`, `.unmerge-modal-row`, `.unmerge-modal-actions`, `.unmerge-modal-lock-checkbox` — standard modal scaffolding. Match the existing visual language (rounded corners, line color from `var(--line)`, white-with-alpha background, accent color from `var(--accent)`).

### Out of this plan

- **`mergeSelectedColors` manual-merge undo** — not in scope. The same merge-graph + unmerge plumbing could later cover it (we'd track manual merges in a parallel structure or write to a `merges[]` log per the schema), but v1 covers auto-merges only.
- **Pixel-click inspection on flatten preview** — natural follow-up. The current swatch-grid Inspect button covers the use case; pixel-click is a nicer affordance for finding the right swatch on busy images.
- **Sub-quantization-bucket granularity** — out of scope. Unmerge operates at the post-quantize-to-12 bucket level.

(The "Sticky do-not-re-merge" flag that was deferred in the unmerge-only draft is now IN scope, expressed as the explicit `locked` flag added during planning.)

## 2. AGENTS.md Flag Check

Walking the "Flag before implementing" list at `AGENTS.md:57-69`:

- **Guest-mode write boundary.** Persistence goes through the existing `POST /projects` and `PATCH /projects/:id/palette` routes, which already enforce `session.kind === "user"`. No new write path.
- **CORS / public origins.** N/A.
- **OAuth tokens.** N/A.
- **User-scoped brand data in repo.** N/A.
- **Relational joins / non-document data model.** N/A — `originalColors` already lives inside the project's palette document.
- **New public endpoint without validation / rate limiting.** N/A — no new endpoints.
- **Bypass upload validation.** N/A.

No flags fire.

"Read before editing" task-adjacent items from `AGENTS.md:18-26`:
- **Touching estimation, palette merging, or paint math → read `packages/core` before writing.** We DO modify `packages/core/src/index.ts` for the Lock half — adding the `lockedIds` option and respecting it in Phase 0 dedup and Phase 2 classification. Already read the relevant sections (`classifyPaletteColors`, `dedupNearestNeighbors`, `findBestMixingPair`) during prior plans. Will re-read immediately before editing to confirm nothing has drifted.
- **Touching API routes → read the route module.** Schema cap-bump + new optional `locked` field. Consuming route handlers do not need code changes (zod accepts the larger array and the new field; downstream logic does not inspect `locked`). Will re-read during implementation to confirm.

"Do not touch without explicit instruction" at `AGENTS.md:71-77`: none of the listed paths are in scope.

## 3. Ambiguity Check

One meaningful ambiguity: **what merge layers does Inspect expose?**

- **Interpretation A — both layers in one flat list.** Phase 0 absorbs and Phase 2 absorbs are presented together, sorted by pixel count. The user doesn't see "this was deduped" vs "this was absorbed as a mix endpoint" — just "these clusters were merged here." Simpler UI. Selected.
- **Interpretation B — grouped by phase.** Phase 0 absorbs labeled as "near-duplicates" and Phase 2 absorbs labeled as "mix members." More informative for power users; more cluttered UI; the distinction matters less to the practical user goal of "split it back out."

Building (A). The user's intent ("see the colors which were merged to get there") doesn't differentiate phases. If a power-user request emerges later, layering on a phase label inside the existing rows is a one-line change.

Other potentially-ambiguous decisions, resolved without listing as alternatives because the user's framing or the data shape settles them:

- **Persist raw clusters server-side** → yes, via existing `palette.originalColors` slot. Otherwise unmerge dies on reload, which kills 80% of the feature's value.
- **Persist `locked` per color** → yes. Same reasoning — a locked color that resets on reload is worse than no lock.
- **Default to locking unmerged colors** → yes, via a default-on "Lock unmerged colors" checkbox in the modal. Matches the dominant intent ("I'm splitting this out because I want it to stick"). User can uncheck if they only want a one-off split.
- **Locked color as a keeper.** Per the user's framing ("other colors could be merged into them"): locked colors stay as legitimate Phase 0 keepers and Phase 2 mixing endpoints. They're only protected from being on the *receiving* end of absorption.
- **Granularity** → post-quantize-to-12 bucket. Below that is per-pixel, which isn't a meaningful "color" to unmerge.
- **Inspect surface** → per-swatch button in v1, not pixel-click on flatten preview. Pixel-click is a follow-up.

## 4. Verification Approach

- `npm run typecheck` — applies. New state, new types (`locked`, `lockedIds`), new helper function, new modal — typecheck catches signature drift.
- `npm run test` — applies.
  - `packages/core/test/index.test.ts` — new tests for the `lockedIds` semantics (Phase 0 keeper override, Phase 2 absorb override). All existing classifier tests must still pass.
  - `apps/api/test/projects.test.ts` — new tests for the larger `originalColors` payload and for the `locked` field round-trip + invalid-type rejection.
- `npm run build` — applies.
- `npm run lint` — applies.
- **Manual repro on the Pages preview** with `docs/example_art/viking_choir.jpg`:
  - Upload. Confirm the swatch grid has Inspect + Lock affordances on every swatch.
  - Open Inspect on the dark mauve swatch (`#483030`). Verify the modal lists warm-tone clusters (the brown skin tones at rgb 156,120,108 and friends) with pixel counts.
  - Check 1-2 of the brown clusters, leave "Lock unmerged colors" checked, click "Unmerge selected." Verify:
    - The modal closes.
    - A new warm-brown swatch appears in the palette grid with a lock indicator.
    - The estimate updates: a new paint row appears, the dark-mauve row's coverage drops by the unmerged cluster's pixel count.
    - The flatten preview re-renders with the warm-brown swatch as the nearest match for face pixels — face now reads as actual skin color instead of slate-gray + mauve.
  - Click Auto-combine to re-classify. Verify the locked warm-brown swatch survives even though its coverage is below 5%.
  - Toggle the lock off, click Auto-combine again. Verify the warm-brown swatch is now absorbed back into a buy endpoint (proving the lock did its job and unlocking restores default behavior).
  - Sign in, save the project, reload. Verify the unmerge state and locked flags persist. Inspect still works on the dark-mauve swatch (showing remaining absorbed clusters).
- **Legacy project check.** Load a project saved before this feature shipped. Inspect modal opens with the "No colors were merged" empty state (since `palette.originalColors` is empty on legacy payloads); Lock toggle still works (it's per-color and doesn't require originalColors). Editor remains usable.
- **Empty state.** On a swatch that genuinely has no absorbed clusters (small singleton "buy" that survived Phase 0/2 untouched), Inspect shows the empty-state copy.

This is user-visible UI behavior per `AGENTS.md:83-94` — ship-it requires CI green plus a preview URL demonstrating both unmerge and lock actions on `viking_choir.jpg`.

## 5. Open Questions

1. **`originalColors` cap value.** Plan recommends `max(1000)`. Viking hits ~800; most images much less. 1000 gives headroom for pathological cases. Higher caps cost wire bytes; lower caps risk dropping clusters and breaking the merge graph. Confirm 1000 during implementation; raise if a test image overflows.
2. **Sticky persistence of `lastClassifiedOptions`.** v1 defaults to balanced on reload, which may give a slightly-different merge graph than what produced the persisted palette if the user had re-classified at a different sensitivity. Acceptable for v1; sticky persistence is a follow-up.
3. **Cache merge-graph per session.** v1 recomputes on every modal open (one classify pass, ~10-50ms). If the user opens many Inspects in a short window, a `useMemo` keyed on `(originalClustersRef, paletteColors, lastClassifiedOptions, lockedIds)` would amortize. Skipped in v1.
4. **Locked colors interacting with `mergeSelectedColors` (manual merge).** Manual merge is user-driven and explicit. Question: should the manual-merge UI prevent the user from picking a locked color as the *absorbed* member? My lean: yes, with a clear UI affordance (locked color shows lock icon in the merge picker, and Merge button is disabled when the keeper would consume a locked color). Out of scope for v1 IF we're treating manual merge undo as a follow-up; but the FORWARD direction (manual merge of currently-locked color) needs a v1 decision. Recommendation: show a confirmation toast — manual merge override unlocks the absorbed color and merges it.
5. **Manual-merge undo.** Out of scope for v1, but the merge graph plumbing leaves a natural extension point. A future plan could capture `mergeSelectedColors` events in a parallel "manual merges" log and present them in the same modal.
6. **Lock icon glyph.** Plan calls for a padlock open/closed visual. We don't currently have an icon system — could be inline SVG, emoji (🔒/🔓), or a CSS-drawn shape. Recommend inline SVG (small, matches existing aesthetic). Final pick during implementation.

## 6. 2026-05-11 — UX revision: "pull" instead of "unmerge"

The user redirected the unmerge UX after reviewing the draft. Concern: a user who wanted to recover a single accent color (e.g. the viking's brown face) shouldn't have to wade through 50 similar shades, multi-select correctly, and click "Unmerge all the right ones." The simpler intent is **"pull this specific color back out — let the system re-merge the rest around it."**

This addendum supersedes specific steps from §1 and one decision from §3.

### Mental model

- The user clicks Inspect on a swatch they think is wrong.
- They see the list of raw clusters that landed in that swatch.
- They click **Pull out** on the one cluster they actually want.
- That cluster becomes a new standalone palette swatch, **always locked**.
- The classifier re-runs on `originalClustersRef.current` with the expanded lockedIds set (all previously-locked colors + the newly-pulled one).
- The other raw clusters that were absorbed into the original swatch are redistributed by the re-run — most will land back in the same keeper, some may now land in the newly-pulled color if they're nearby, and a few may shift to other survivors.
- The user gets exactly the swatch they wanted, with no cognitive load about "which 14 of these 50 do I unmerge."

This is functionally identical to "add a locked color and re-run classifier" — which the Lock feature already provides. The Inspect modal becomes a discovery + invocation surface for that capability.

### Supersedes

- **§1 step 19 (modal component props).** No longer needs `onUnmerge(ids[], lockUnmerged)`. New prop: `onPullOut(clusterId: string): void`.
- **§1 step 20 (modal markup).**
  - Header unchanged: "Colors merged into [color chip] [hex]".
  - Body: same scrollable list, but each row has a single **"Pull out"** button on the right (no checkboxes).
  - Footer: just Cancel. No "Unmerge selected" / "Unmerge all" / "Lock unmerged" controls.
  - Backdrop click + Esc closes.
- **§1 step 21 (open-state).** Unchanged.
- **§1 step 22 (action function).** Replace `unmergeColors(keeperId, clusterIds[], lockUnmerged)` with `pullColorOut(clusterId)`:
    1. Look up the cluster in `originalClustersRef.current` → get hex, rgb, pixelCount.
    2. Construct a new `PaletteColor` entry from the cluster's hex/rgb/pixelCount; set `locked: true`, `disabled: false`.
    3. Append it to a copy of the current `paletteColors`.
    4. Re-run `classifyPaletteColors(originalClustersRef.current, { ...lastClassifiedOptions, lockedIds: <all locked ids INCLUDING the newly-pulled one> })`. The classifier respects the lockedIds set so the pulled color survives, and other clusters absorb into nearest survivors per the existing algorithm.
    5. From the classifier result, derive the new visible palette via `applyClassification` and `rebalanceCoverage` (same shape as today's Auto-combine path).
    6. The new visible palette **includes the pulled color** plus whatever the re-classify produced. Update `setPaletteColors`, `setClassifications`, `setMixRecipes`.
- **§1 step 23 (rebalanceCoverage, etc.).** Folded into the re-classify pass above.
- **§1 step 24 (close modal).** Unchanged.
- **§3 ambiguity check decision "Default to locking unmerged colors → yes via a default-on checkbox."** Superseded: there is no checkbox now. Pulled colors are **always** locked; that's the whole point of pulling vs unmerging. The checkbox doesn't exist.

### Why this is cleaner

- One verb, one button per row, no multi-select UI complexity.
- No risk of the user accidentally unmerging the wrong subset and producing a 60-swatch palette.
- Re-merging "around" the pulled color is free — it's just re-running the same classifier the user is already familiar with from Auto-combine, but now with one more locked input.
- The classifier itself is doing the work the user would have to do manually under the old design ("re-merge the 49 colors I don't care about").

### Edge cases worth flagging

- **Pulling a color that's already in the visible palette.** Shouldn't be possible because the merge-graph helper already filters out clusters whose ids are present in current `paletteColors` (step 15). Belt-and-suspenders: `pullColorOut` checks and no-ops if the cluster id is already a visible palette entry.
- **Pulling a color from a swatch that has no merged-in clusters.** Modal shows the empty state and there are no Pull buttons to click. No-op by design.
- **What if the user pulls a color that ends up being immediately re-absorbed by the classifier despite being locked?** Cannot happen — the classifier's lockedIds path forces the pulled color to stay buy regardless of coverage.
- **What if the re-classify pass with one extra locked color produces a slightly different overall palette (e.g., a previously-absorbed cluster now lands on the pulled color and would have been a mix)?** Expected behavior. The user clicked Pull on a specific color intent; the surrounding palette adjusting is the entire point of the redistribute-on-pull design.

### What stays from the original plan

Everything else in §1 stays as written: state additions, originalClustersRef plumbing, lastClassifiedOptions, the Lock toggle on swatches (orthogonal to Pull — user can still lock any swatch directly without going through Inspect), the schema cap bump, the `locked` field, the merge-graph helper, persistence round-trip, CSS additions. The classifier modification in §1.1-4 (`lockedIds` option) is still required — Pull relies entirely on it.

## 7. 2026-05-11 — UX revision: trigger is the art, not the swatch grid

Further user redirect: the user doesn't want to click on a swatch and dig into a modal. They want to look at the rendered art, see a region that's the wrong color, and **click/tap directly on that region** to pull out the correct color. Eyedropper-style direct manipulation.

This addendum supersedes the modal-based interaction described in §6 and the Inspect-button steps from §1.

### Mental model

- User looks at either the source preview or the flatten preview in the FieldSheet (`apps/web/app/PrototypeApp.tsx` FieldSheet component around `PrototypeApp.tsx:1631+`).
- They see a region that's rendered wrong (e.g. the viking's face shown as slate-gray + mauve in the flatten preview).
- They tap/click that region.
- We sample the **source** pixel at that location (from `sourcePixelsRef.current`, regardless of which preview they tapped — both previews share the same source pixel grid).
- We quantize the sampled RGB to the 12-channel grid (`Math.round(c/12)*12`).
- We look up the quantized cluster in `originalClustersRef.current`.
- We add that cluster as a locked palette entry, then re-run the classifier with the expanded lockedIds set (per §6's pullColorOut action).
- Net result: one tap → new locked swatch appears in the grid → flatten preview re-renders with the new swatch present, so the tapped region now reads as its actual color.

### Supersedes

- **§1 step 17 (per-swatch Inspect button).** Gone. The swatch card has no Inspect button. Lock toggle (step 18) STAYS — user can still manually lock any visible swatch directly.
- **§1 steps 19-21 (modal component, markup, open-state).** Gone. No modal. No `inspectColorId` state.
- **§1 step 22 (pullColorOut function signature).** Still `pullColorOut(clusterId: string)`, but the trigger is the art-tap handler, not a modal click.
- **§6 supersession of §1 steps 19-22.** Replaced by this section — no modal in the final design.

### New: art-tap handler

- Add `onClick` / `onTouchEnd` handlers to the `<img>` elements that render `originalImageUrl` and `reducedImageUrl` inside the FieldSheet preview panels (`apps/web/app/PrototypeApp.tsx:1631+` for the FieldSheet component, plus wherever the previews are inserted on the main editor view — currently `<FieldSheet>` is the main consumer).
- Handler signature: `handleArtTap(event: ReactMouseEvent<HTMLImageElement>)`.
- Implementation:
    1. Compute click coords relative to the `<img>` element's bounding rect.
    2. Scale coords to `sourcePixelsRef.current` dimensions: `srcX = clickX / img.clientWidth * sourcePixelsRef.current.width`, similarly for y.
    3. Read RGB from `sourcePixelsRef.current.data` at `srcX, srcY`.
    4. Quantize: `qr = Math.round(r/12)*12`, similarly for g and b.
    5. Find the cluster in `originalClustersRef.current` whose `rgb` matches `(qr, qg, qb)`. If none (image was pre-feature without raw clusters, or pixel is alpha-low / out-of-bounds), no-op silently.
    6. If the cluster's `id` is already in `paletteColors`, no-op silently (or show a brief toast: "This color is already in your palette.").
    7. Otherwise, invoke `pullColorOut(cluster.id)`.

### UX feedback

- The new swatch appears at the top of the swatch grid with a brief highlight/pulse animation (CSS keyframe) so the user can visually confirm "yes, that's the color I tapped."
- Optional toast above the swatch grid: "Pulled color [hex chip] [hex string] — locked." Auto-dismiss after 3s.
- Cursor styling: `cursor: pointer` on the preview images to signal interactivity.

### Edge cases (revised)

- **Tapping a region whose quantized bucket isn't in originalClustersRef.** Can happen if the image was hydrated from a pre-feature project (no raw clusters persisted). Silent no-op; consider a one-time hint banner under the preview: "Tap a region of the art to extract that color. (Re-upload this project to enable.)"
- **Tapping a region whose bucket is already a visible swatch.** No-op with optional toast: "This color is already in your palette."
- **Tapping the white border / background of the image element.** clientWidth scaling handles this automatically — coords map to a transparent or pure-white source pixel, which either has alpha < 128 (no-op) or quantizes to a bucket that may or may not exist.
- **Tapping rapidly multiple times.** Each tap is independent. If two taps hit different quantized buckets, both get pulled out. Classifier re-runs on every pull.
- **Mobile vs desktop interaction.** Same handler covers both via React's synthetic events. Touch responsiveness should be fine — no scroll/swipe gestures to disambiguate from on a static `<img>`.

### What stays from §6 and §1

- The classifier `lockedIds` modification in §1 steps 1-4 — required.
- The `locked` field on PaletteColor / schema — required.
- The Lock toggle on each swatch — STAYS as a direct lock-by-swatch affordance for users who want to lock an existing swatch without pulling anything.
- The originalClustersRef plumbing — required.
- The lastClassifiedOptions plumbing — required.
- The schema cap bump for originalColors — required.
- The pullColorOut action function — required, just triggered from art-tap instead of modal.
- Persistence round-trip for `locked` and `originalColors` — required.

### What's gone

- All "Inspect modal" code: component, props, open-state, markup, CSS classes (`.unmerge-modal*`, `.swatch-inspect-button`).
- The merge-graph helper (`computeMergeGraph` from §1 step 15-16) — no longer needed because we don't enumerate "which clusters merged into this swatch." We just take whatever cluster the user tapped.

### Net implementation footprint vs the original plan

Smaller. We trade:
- ~80-120 LOC of modal scaffolding + state + click wiring
- The `computeMergeGraph` helper (~30 LOC)
- Modal CSS

For:
- ~40 LOC of art-tap handler + coord math
- ~10 LOC of toast/highlight feedback
- Cursor style + (optional) hint banner CSS

Net reduction: ~50-100 LOC. The classifier `lockedIds` plumbing remains the biggest single piece of work.

## 8. 2026-05-11 — Workflow framing: proactive (source) vs reactive (flatten)

User clarification on the natural user journey, refining §7. **Both previews remain tappable with identical behavior** — the addendum is about affordance hints + copy, not implementation. The framing also serves as the educational story for the in-app help banner.

### Two phases of the same action

| Phase | Surface | User intent | Hint copy |
|---|---|---|---|
| **Proactive** | Source preview (the original uploaded art) | "These are colors I know matter for this piece — I want them in my palette regardless of how the classifier ranks them." | "Tap a color you want to keep. We'll merge other colors around it." |
| **Reactive** | Flatten / reduced preview | "Auto-merge over-collapsed something — let me fix it." | "Tap a region that's the wrong color. We'll pull that color back into the palette." |

Both invocations land in the same `pullColorOut(clusterId)` action. The classifier respects the now-locked color and redistributes other clusters around it. Mechanically identical — workflow-wise, just two natural entry points.

### Natural user journey

1. **Upload.** Classifier runs at balanced sensitivity (existing classify-on-upload behavior from PR #10). Initial palette appears in the swatch grid.
2. **Proactive picks (optional).** User scans the source preview and taps the colors they consider essential — e.g. the viking's brown face, the red sail. Each tap pulls that color out as a locked swatch, re-runs the classifier, and updates the palette around the lock.
3. **Reactive fixes.** User scans the flatten preview for regions that don't match the source. Taps to pull each problem color out.
4. **Re-classify if needed.** Manually click Auto-combine to re-pass at a different sensitivity. Locks are preserved across the re-classify.
5. **Skip / Disable for non-paint regions** (the existing feature from PR #11): user can skip bare-wall background colors from the estimate.

Step 2 is optional — users who don't want to think hard get a sensible default palette from step 1 and can fix what's wrong in step 3. Power users go straight to step 2.

### Hint banners

- Above the source preview panel: "Tap a color you want to keep" with a subtle ⓘ tooltip explaining the proactive workflow.
- Above the flatten preview panel: "Tap a region to fix its color" with a subtle ⓘ tooltip explaining the reactive workflow.
- Both panels share a `cursor: pointer` style on the `<img>` element so the affordance is obvious from hover.

### No code path divergence

`handleArtTap` does not need to know which preview was tapped. The behavior is identical: sample the source pixel from `sourcePixelsRef.current` at the click coords, quantize, look up the cluster, call `pullColorOut`. The "proactive vs reactive" distinction lives only in the UI copy and the user's head.

### What this clarifies

- We do NOT remove or defer the classify-on-upload step from PR #10. Step 1 still produces an initial balanced palette. The proactive/reactive interactions iterate on it.
- The Auto-combine button is repositioned in copy: tooltip becomes "Re-run auto-merge at current sensitivity. Locked colors are preserved." Same code, same behavior.
- No new state, no new actions, no new components.

### What stays from §7

Everything. Implementation is unchanged. §8 is purely the human-facing framing layer on top.
