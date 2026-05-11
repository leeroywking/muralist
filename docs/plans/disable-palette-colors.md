# Disable Palette Colors — Plan

Task summary: Add a per-color "disable" toggle to the palette. Disabled colors are excluded from the estimate and from the maquette PDF's swatch table, and their pixel regions render as a diagonal-stripe hatch (the standard "no-fill / empty" UI convention) in both the flatten preview and the PDF's reduced-mural preview. Anchor use case: a mural where the dominant background is bare wall and should not be painted; generalized so any color can be disabled.

## Background — what "disabled" means in this app

- Disabled colors **stay in the palette state** and remain visible in the swatch grid (muted, with the hatch overlay) so the user can re-enable them.
- Disabled colors are **excluded** from: estimate math, container plan, maquette PDF swatch table, and Auto-combine classifier input.
- Disabled regions **remain visible** in the flatten preview (and in the reduced-mural panel of the PDF) but render as the hatch pattern rather than their hex color, so the user can see *where* the disabled regions sit in the artwork.
- Disabled state is **persisted per-project** so save/load preserves the user's selections.

Coverage values are **not renormalized** when a color is disabled. The remaining colors keep their original `coverage` percentages and the painted-area sum naturally drops below 100%. This is correct for the "background is bare wall" use case: estimate covers only the actually-painted area, not the whole wall.

## 1. Step-By-Step Plan

### `packages/core` — untouched

`deriveColorAreaEstimates`, `suggestContainersForColors`, `applyMixesToCoverage`, `classifyPaletteColors`, `applyClassification`: signatures and implementations unchanged. We filter at the call sites in `apps/web` instead of pushing the "disabled" concept into the core library — the library stays pure, disabled is a UI/persistence concern.

### `apps/api/src/schemas/project.ts` — schema change (one field, optional)

1. Add `disabled: z.boolean().optional()` to `paletteColorSchema` at `apps/api/src/schemas/project.ts:11-16`. Optional so legacy payloads (no `disabled` field on any color) still validate.
2. The existing coverage-sums-to-1.0 refine at lines 53-57 remains unchanged. Disabled colors keep their `coverage` values, so the sum still equals 1.0.
3. No changes to other zod schemas (`mergeOperationSchema`, `mixRecipeSchema`, `paletteJsonSchema`'s top-level fields, etc.).
4. Update `apps/api/test/` palette schema tests to assert: (a) payload with `disabled: true` on one entry validates; (b) payload without any `disabled` fields still validates; (c) `disabled: "yes"` rejects.

### `apps/web/app/apiClient.ts` — type addition

5. Add `disabled?: boolean` to the `PaletteColor` type at the (export from) `apiClient.ts`. The type is what server-bound payloads conform to client-side. Optional matches the schema.

### `apps/web/app/editorPersistence.ts` — round-trip the flag

6. Add `disabled?: boolean` to `EditorPaletteColor` type (line 64-70).
7. In `toBackendPaletteColors` (line 86-110): when `color.disabled === true`, set `backendColor.disabled = true`. Omit otherwise — keeps the wire payload compact and backwards-compatible.
8. In `toEditorPaletteColors` (line 205-220): when `color.disabled === true`, set the editor color's `disabled = true`. Treat missing as `false` (default).

### `apps/web/app/PrototypeApp.tsx` — state, UI, and call-site filters

9. Extend the in-memory `PaletteColor` type at the editor side (`AnalysisResult.colors` is currently `PaletteColor[]`; add `disabled?: boolean` to that). Default to `disabled: false` everywhere it's set (analyze, classify-on-upload, manual merge, auto-combine re-run, hydration).
10. **Swatch UI** at `PrototypeApp.tsx:1464-1510`: add a small toggle control inside each swatch card. Suggested shape: an "Include / Skip" pill or a checkbox labeled "Include in estimate" with the disabled-state visual swap to "Skipped". When disabled:
    - Swatch card gets a `swatch-card-disabled` class (new CSS, see step 17).
    - The color preview block at line 1482 renders the hatch overlay instead of (or layered on top of) the hex color.
    - Coverage % and finish/coats controls render muted but remain editable so the user can prep before re-enabling.
11. **Estimate filter** at `PrototypeApp.tsx:247-261` (`adjustedCoverage` useMemo): filter out `paletteColors.filter(c => !c.disabled)` before mapping. `applyMixesToCoverage` receives only enabled colors. Coverage values are NOT renormalized.
12. **Container plan** at `PrototypeApp.tsx:263-294` (`containerPlan` useMemo): no change — it already consumes `adjustedCoverage`, which step 11 has already filtered.
13. **Field-sheet model** at `PrototypeApp.tsx:296+` (`fieldSheetModel` useMemo): build `colors: FieldSheetColorWithClassification[]` from the **enabled** palette only. Disabled colors don't appear in the maquette PDF's swatch table.
14. **Flatten preview** — `flattenImageToPalette` at `PrototypeApp.tsx:1980-2025`: extend signature to accept `(source, palette, options?)` where options can carry a precomputed hatch `CanvasPattern`. For each pixel: still find the nearest palette match across **all** colors (including disabled — pixels need to land *somewhere*); if that match is disabled, write the hatch pattern's color/alpha to the output instead of the palette RGB. Implementation: a second pass after the per-pixel loop that rewrites disabled-assigned pixels using a precomputed 16×16 hatch ImageData tiled across the disabled-assigned coordinates. Returns a data URL same as today.
15. **Auto-combine classifier input** at `PrototypeApp.tsx:870-933` (`handleAutoCombine`): filter `paletteColors` to enabled colors before mapping into `classifierInput`. Disabled colors stay in `paletteColors` and bypass classification entirely. The classification map keys for disabled colors should NOT be cleared (they keep their last classification, e.g. "buy", in case the user re-enables).
16. **Classify-on-upload** at the upload call site (the rewritten block in `PrototypeApp.tsx:669-735` from the previous PR): no change for v1. All colors start `disabled: false` on a fresh upload, and run through classification. User toggles disable after seeing the swatch grid. (If we later want "auto-disable the biggest color" as a UX, that's a follow-up — out of scope here.)

### `apps/web/app/maquettePdf.ts` — hatch in the rasterized preview, no special schema

17. No code change required if step 14 bakes the hatch into the flatten data URL before the PDF embeds it. The `reducedImageUrl` arg to `downloadMaquettePdf` is the flatten preview's data URL — by the time it reaches the PDF, hatch is already painted.
18. No code change required for the swatch table either — step 13 filters disabled colors out of `fieldSheetModel.colors`, which is what `drawSwatchTable` iterates.
19. Confirm the "totals" panel at `maquettePdf.ts:760-805` reports gallons/cost across only the visible colors (it already sums from `model.totals`, which step 13 derives from the filtered `containerPlan` — automatically correct).

### `apps/web/app/styles.css` — CSS additions

20. Add `.swatch-card-disabled` (muted card body, slight opacity reduction).
21. Add `.swatch-disabled-hatch` (background SVG data URL of diagonal black stripes on neutral gray, applied inside the swatch preview block when disabled). Spec: 8×8 px tile, 45° black stripes on `#E5E7EB`, 35% opacity stripes so it reads as "skipped" not "loud warning."
22. Add a `.swatch-toggle-disable` button style adjacent to existing `.swatch-toggle` (used for selection) — distinct shape/icon so the two affordances don't visually collide.

### `apps/web/app/PrototypeApp.tsx` — UI copy (small)

23. One-line help text under the swatch grid header: *"Toggle Skip on a color to leave it out of the estimate and maquette — useful for backgrounds that are bare wall."* Placement: above or below the existing classification badge legend.

### Migration / backwards compat

24. Projects saved before this feature: hydration treats missing `disabled` as `false` (step 8 already handles this). No data migration needed.
25. Projects saved with this feature: legacy clients (no `disabled` awareness) will simply ignore the field on read, treat all colors as enabled. Worst case: estimate over-counts on an old client. Acceptable for a small client-only field.

## 2. AGENTS.md Flag Check

Walking the "Flag before implementing" list at `AGENTS.md:57-69`:

- **Guest-mode write boundary.** Persistence change goes through the existing `PATCH /projects/:id/palette` route, which already enforces `session.kind === "user"` (per `apps/api`). No new write path, no boundary change.
- **CORS / public origins.** N/A — no network surface change.
- **OAuth tokens.** N/A.
- **User-scoped brand data in repo.** N/A — `disabled` is per-project palette state, not brand defaults.
- **Relational joins / non-document data model.** N/A — `disabled` lives inside the project document's palette JSON.
- **New public endpoint without validation/rate limiting.** N/A — no new endpoint.
- **Bypass upload validation.** N/A — no change to `imageValidation.ts`.

No flags fire.

"Read before editing" relevant entries from `AGENTS.md:18-26`:
- **Touching estimation, palette merging, or paint math → read `packages/core` before writing.** We are NOT editing `packages/core`; we filter at apps/web call sites before invoking core's functions. Core stays pure. Already read core during the prior PR so the call signatures are confirmed.
- **Touching API routes → read `apps/api` entry and the relevant route module before editing.** Schema-only change to `apps/api/src/schemas/project.ts`. The route module that consumes the schema (`PATCH /projects/:id/palette`, `POST /projects`) does not need code changes — zod parses the additional field automatically and the downstream business logic doesn't read `disabled`. Will re-read the route during implementation to confirm no special-cased palette inspection that needs updating.
- **Touching upload validation.** N/A — no change to `imageValidation.ts`.
- **Touching tier limits or upload caps.** N/A.

"Do not touch without explicit instruction" at `AGENTS.md:71-77`: none of the listed paths are in scope.

## 3. Ambiguity Check

One meaningful ambiguity, two viable interpretations of the disabled-region fill in the flatten preview:

- **Interpretation A — diagonal-stripe hatch on neutral gray.** Matches the user's "black with diagonal lines" reference. Reads as "this region is intentionally skipped." Single CSS/canvas pattern. Selected — plan is built around this.
- **Interpretation B — Photoshop-style checkerboard (transparency convention).** Equally classy, reads as "no fill." More photo-editor-ish. One-line swap from (A) if the user prefers it after seeing the live preview.

Will ship (A) by default and surface (B) as a one-CSS-pattern swap if the live preview misses the mark.

Other potentially-ambiguous decisions resolved without listing as alternatives, because the user's phrasing or the data model makes the choice clear:

- Coverage renormalization on disable → no (user phrased the use case as "bare wall not painted"; painted area should not be inflated).
- Maquette PDF treatment → omit disabled rows from the swatch table (user said "not present"); the rasterized preview shows hatch regions automatically via the upstream flatten step.
- Auto-disable biggest color on upload → no (out of scope, follow-up).

## 4. Verification Approach

- `npm run typecheck` — applies. Type additions across schema, apiClient, persistence module, and PrototypeApp; typecheck catches any missed call sites.
- `npm run test` — applies. New cases in `apps/api/test/` for the schema change (see step 4). Existing tests in `packages/core/test/` and `apps/api/test/` must still pass — we don't change core internals or break the coverage-sums-to-1 invariant.
- `npm run build` — applies. Static export must still produce.
- `npm run lint` — applies.
- **Manual repro on the Pages preview deploy**, uploading `docs/example_art/flowers.jpg`:
  - Confirm a "Skip" toggle appears on every swatch.
  - Toggle the dominant sage-green swatch to disabled. Verify:
    - The swatch tile renders with hatch overlay and muted styling.
    - The estimate gallons + cost drop noticeably (no green paint planned).
    - The flatten preview shows the green-assigned regions as hatch, not green.
    - Container plan section omits the green color row.
    - Maquette PDF download omits the green row in the swatch table and shows hatch in the reduced-mural preview panel.
  - Re-enable the green swatch; verify the estimate, flatten preview, and PDF all return to the pre-disable state.
  - Save the project, reload, confirm the disabled flag persists. Open from `/projects` and confirm the green is still disabled.
- **Backwards-compat check.** Open a pre-existing project saved before this feature shipped (one of the earlier test projects on the user's account); confirm it loads and all colors appear enabled by default.

Because this is user-visible UI behavior per `AGENTS.md:83-94`, ship-it = CI green + preview URL demonstrating the toggle + the hatch render + the estimate drop.

## 5. Open Questions

All answered during planning. Recorded here for the PR trail:

1. **Hatch visual.** Diagonal-stripe hatch on neutral gray. Neither this nor the Photoshop checkerboard convention is copyrighted; user picked whichever is non-encumbered, and diagonal stripes match the user's "black with diagonal lines" reference. Decision: **diagonal stripes**.
2. **Toggle affordance.** Decision: **pill** ("Include" / "Skip"). Discoverable, fits the swatch card layout.
3. **Saved-merge-plan (guest-only localStorage) round-trip.** Self-note for implementation: verify the localStorage deserializer at `PrototypeApp.tsx:1097` (`setClassifications(savedMergePlan.classifications ?? {})` and surrounding restore code) doesn't strip unknown `disabled` fields on the `paletteColors` array. Expected to be a one-line no-op confirmation (JSON.parse preserves all fields).
4. **Quick-action "disable biggest color on upload."** Decision: **never auto-disable.** Always a user choice. Confirmed explicitly by user.
5. **Test artifact.** Survey/flatten/estimate pipeline lives inline in `PrototypeApp.tsx` and isn't unit-testable without extraction. Follow-up extraction-for-testability PR will cover: (a) the `disabled` filter through `adjustedCoverage`, (b) the hatch overlay in `flattenImageToPalette`, (c) the persistence round-trip. Not in this PR.

### Manual test target for flowers.jpg

The "background" for verification purposes is the **sage-green color that touches the entire top and left edges** of `docs/example_art/flowers.jpg`. Disabling that swatch should:
- Drop the estimate gallons/cost noticeably (it's the dominant palette member).
- Render those green regions as hatch in the flatten preview and the PDF's reduced-mural panel.
- Omit the green row from the PDF's swatch table.
