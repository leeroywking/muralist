# Auto-Combine Colors Plan

Task summary: Add a one-click `Auto-combine similar colors` button that reduces the current palette toward ~10 colors by greedy nearest-pair RGB-distance merging, keeping the highest-coverage color in each group. Manual merge, save-merge, and restore flows stay unchanged.

## 1. Step-By-Step Plan

### `packages/core`

1. Add new exported types to `packages/core/src/index.ts`.
   - `AutoCombineColorInput = { id: string; rgb: [number, number, number]; pixelCount: number }`.
   - `AutoCombineGroup = { keeperId: string; memberIds: string[]; mergedPixelCount: number }`.
   - `AutoCombineResult = { groups: AutoCombineGroup[]; mergedCount: number }`.
   - Keep types web-agnostic — do not import `PaletteColor` shape from `apps/web`.

2. Add `autoCombineColors(colors, options)` to `packages/core/src/index.ts`.
   - `options = { targetCount: number }`; assert `targetCount >= 1` via `assertPositiveFinite`.
   - Algorithm: while group count > targetCount, find the pair with the smallest squared RGB distance and merge them — the higher-`pixelCount` color becomes the keeper; member id folded in; keeper's rgb left unchanged (pixel-weighted recentering would shift the displayed swatch in a way the user did not pick).
   - Tie-break on equal distance: prefer merging groups whose combined `pixelCount` is smallest, then by lexicographic keeper id — so runs are deterministic and tests are stable.
   - If `colors.length <= targetCount`, return `{ groups: [every color as its own singleton], mergedCount: 0 }`.

3. Add tests to `packages/core/test/index.test.ts`:
   - Reduces a palette of 15 near-duplicate colors to `targetCount = 10` and returns `mergedCount === 5`.
   - The keeper of a merged pair is the color with the higher `pixelCount`.
   - No-op when the palette already sits at or under `targetCount` (mergedCount is 0, every group is singleton).
   - Deterministic grouping when multiple pairs share the same distance — reruns produce identical `groups`.
   - Throws on `targetCount <= 0` or non-finite `targetCount`.

### `apps/web`

4. Extend the core import block in `apps/web/app/PrototypeApp.tsx` to include `autoCombineColors` and its types.

5. Add `handleAutoCombine` next to `mergeSelectedColors` in `PrototypeApp.tsx`.
   - Build `AutoCombineColorInput[]` from current `paletteColors`.
   - Call `autoCombineColors(input, { targetCount: AUTO_COMBINE_TARGET })` with a module-level constant `AUTO_COMBINE_TARGET = 10`.
   - Build next palette: for each `AutoCombineGroup`, keep the original `PaletteColor` matching `keeperId`, replacing its `pixelCount` with the group's `mergedPixelCount`.
   - Sort the next palette by `pixelCount` descending (same as `mergeSelectedColors` does today).
   - Prune `colorFinishOverrides` and `colorCoatsOverrides` for dropped ids — reuse the exact retained-id filter pattern used in `mergeSelectedColors`.
   - Reset `selectedColorIds` and `mergeKeeperId` (same post-merge cleanup as manual merge).
   - Run `rebalanceCoverage` on the result so coverage percentages re-total correctly.
   - Set `saveMessage` to `Auto-combined N colors into M groups.` when `mergedCount > 0`, otherwise `Nothing to combine.`.

6. Add an `Auto-combine similar colors` button to the merge toolbar block in `PrototypeApp.tsx` (next to `Merge Selected`).
   - `disabled` when `paletteColors.length <= AUTO_COMBINE_TARGET` or there is no palette.
   - Reuse the existing `.save-button` className so no CSS change is strictly required.
   - `type="button"`, label updates copy only.

### Not touched

- `apps/api/**`, `apps/mobile/**`, `packages/config/**`, `config/paint-brands.yaml`.
- `.github/workflows/**`, root and workspace `package.json` scripts, `tsconfig*.json`, `apps/web/next.config.mjs`.
- `apps/web/app/maquettePdf.ts` — reads `FieldSheetModel` which derives from `paletteColors`; no change needed once the palette has been auto-combined.

## 2. AGENTS.md Flag Check

- Guest-mode persistent write boundary: **N/A**. Nothing written to server or disk; auto-combined palette is saved the same way manual merges are (browser `localStorage`), already inside the guest-safe `SavedMergePlan` path.
- CORS widening: **N/A**. No API changes.
- OAuth provider tokens: **N/A**.
- DynamoDB-first modeling: **N/A**.
- New public endpoint / rate limiting: **N/A**.
- Upload validation: **N/A** — operates on in-memory palette after the existing upload gate.
- Committed user-scoped data: **N/A** — do not commit generated palettes or example outputs.
- `packages/core` purity: **applies**. `autoCombineColors` must stay I/O-free (no DOM, no canvas, no network). The plan honors this: web-agnostic input type, deterministic math, no React or browser API references.
- Hands-off surfaces (CI, scripts, tsconfig, next.config basePath): **not touched**.

## 3. Ambiguity Check

One meaningful ambiguity: **reduction strategy**.

- Option A (chosen): greedy nearest-pair merge toward a target count of 10. Predictable output size, matches the "one-page PDF" promise shipped in the client-side maquette PDF PR, and stays deterministic with the tie-break rule.
- Option B: fixed RGB-distance threshold with no target count. Only merges visually close pairs. Downside: palette size is unpredictable — on a noisy photo the result can still be 20+ colors, breaking the one-page PDF guarantee.

This is a config choice, not two user-visible UI variants worth comparing side by side in the preview, so building only Option A.

Already-answered ambiguities from triage (noted here for the PR trail):

- Target count: `10`, hard-coded to match PDF page-one cap.
- Knob / aggressiveness slider: **not** adding one; user asked for a simple one-click button.
- Starting point: runs on the current palette (composes with any manual merges the user already did), does not reset to the original 50-color capture.

## 4. Verification Approach

Run from repo root after implementation:

- `npm run typecheck`
- `npm run test`
- `npm run build`
- `npm run lint`

Manual on the Pages preview once CI finishes:

- Upload `docs/example_art/winding-path-9840681_640.jpg` — initial palette captures up to 50 colors.
- Confirm the `Auto-combine similar colors` button is enabled and the `Merge Selected` button still works.
- Click `Auto-combine similar colors`; confirm the palette drops to 10 colors, coverage percentages re-total to ~100%, and the status line reports how many colors were combined.
- Run one manual merge afterwards; confirm it still works on the reduced palette.
- `Save Merge Choices`, reload, `Restore Saved Palette`; confirm the auto-combined palette restores intact.
- Click `Download Maquette PDF`; confirm the PDF's swatch column shows the 10 auto-combined colors at the expected coverage, and still fits on a single page.

## 5. Open Questions

1. Should `AUTO_COMBINE_TARGET` move to a shared constant in `packages/core` so the PDF's one-page cap reads the same source of truth? Plan keeps it a local `apps/web` constant for now — promote to core if a second caller appears.
2. Status-line copy: `Auto-combined 18 colors into 10 groups.` vs `Combined 18 colors.` — plan uses the first for clarity; flag if you prefer shorter.
3. Is tie-breaking by `mergedPixelCount` ascending (plan) the right secondary rule, or would you rather tie-break on higher pixel count (merge bigger groups first) so dominant colors absorb their neighbors earlier? Plan stays with the smaller-first rule so small rare colors don't survive artificially long, but happy to flip if you want the other behavior.
