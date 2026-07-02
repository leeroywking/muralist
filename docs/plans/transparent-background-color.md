# Transparent background color (bare-wall / no-paint per-color flag)

**Task:** Let the user flag palette colors as "background" (bare wall). Flagged
colors are excluded from the paint estimate AND render as show-through
transparency in the flatten preview + maquette PDF. The flag persists across
device drafts and cloud projects.

## 1. Step-by-step plan (file paths)

Represented as a side-list `transparentColorIds: string[]`, mirroring the existing
`finishOverrides` / `coatsOverrides` pattern (sparse, leaves color objects and
back-compat untouched).

**`apps/web/app/PrototypeApp.tsx`**
1. State: `transparentColorIds: Set<string>` + `setTransparentColorIds`; a
   `toggleTransparentColor(id)` handler.
2. Estimate exclusion: `const paintablePalette = paletteColors.filter(c => !transparentColorIds.has(c.id))`;
   feed `paintablePalette` into the `containerPlan` memo (~L264) and
   `fieldSheetModel` memo (~L297) in place of `paletteColors`. Coverage math is
   already whole-image-relative, so no renormalization — remaining colors keep
   true areas. (This one filter also drops flagged colors from the PDF can-list,
   which reads `fieldSheetModel.colors`.)
3. `flattenImageToPalette` (~L2087): accept `transparentColorIds`; when the
   nearest palette color's id is flagged, write `alpha = 0` instead of the fill.
   Pass the set from the memo that builds `flattenedImageUrl`.
4. Clear `transparentColorIds` in the three reset paths: `handleFileChange`
   (upload), `handleResetPalette`, `handleFullReset`.
5. UI: per-swatch "Background / no paint" toggle in the palette grid (~L1594),
   with a badge + dimmed style on flagged swatches. Flagged colors stay VISIBLE
   in the grid (so the user can un-flag and see what's excluded).
6. `buildEditorSnapshot` (~L970): include `transparentColorIds` as `string[]`.
7. Device draft: add `transparentColorIds` to the `SavedMergePlan` shape; set in
   `saveMergedChoices` (~L946), restore in `restoreSavedChoices` (~L1078).

**`apps/web/app/editorPersistence.ts`**
8. `EditorSnapshot`: add `transparentColorIds: string[]`.
9. `PaletteJson` type + `buildPaletteJson` (~L121): add optional
   `transparentColorIds` (only when non-empty, matching the overrides pattern).
10. `hydrateFromProject` (~L242): read `palette.transparentColorIds ?? []` back
    into the hydrated snapshot; thread into `PrototypeApp`'s load effect (~L561).

**`apps/api/src/schemas/project.ts`**
11. Add to `paletteJsonSchema` (~L43):
    `transparentColorIds: z.array(z.string().max(100)).max(200).optional()`.
    (Validates the new field on the existing endpoint — see flags below.)

**`apps/api/src/types.ts`**
12. Add `transparentColorIds?: string[]` to the `PaletteJson` type (~L83 area).

**`apps/api/src/routes/projects.ts`** — no logic change expected: `body.palette`
is stored pass-through after schema validation; confirm the new field survives the
create (~L212) and palette-update (~L367) writes. The optimistic-lock document
`version` keeps auto-incrementing; no manual bump.

**`apps/web/app/maquettePdf.ts`** — no direct change expected: the embedded
maquette image (`reducedImageUrl` → `rasterizeToPng` → `embedPng`, ~L937) inherits
alpha from `flattenImageToPalette`, and the can-list is already filtered via
`fieldSheetModel`. Verification step: confirm `rasterizeToPng` preserves alpha
(does not paint a white canvas background).

**No `packages/core` change** (estimate exclusion is a web-side filter; core stays
pure) and **no `packages/config` change**.

## 2. AGENTS.md flags

- **Guest-mode boundary** (`session.kind === "user"` gates persistent writes): no
  new write path is added. Cloud writes go through the existing validated
  `POST /projects` and `PUT /projects/:id/palette`, which already enforce the
  boundary; guests persist only to `localStorage` (device draft) — unchanged.
- **New public endpoint needs input validation:** not a new endpoint, but a new
  field — added to `paletteJsonSchema` (Zod: string, length ≤100, count ≤200), so
  it is validated, not free-form.
- **Document-shaped, no joins:** the flag is an array of ids on the palette
  sub-document; no relational join or cross-aggregate reference introduced.
- **Do-not-touch:** no CI/workflows, no `package.json` scripts, no `tsconfig`, no
  `next.config.mjs`, no dependency bumps.
- Not touching: CORS, OAuth tokens, upload validation.

## 3. Ambiguity check

Minor, stated rather than blocking:
- **Flagged-color visibility in the palette grid** — (a) keep visible with a
  "background" badge + toggle so the user can see/undo what's excluded
  (**building this**), vs (b) hide it entirely. (a) is more discoverable and
  reversible.
- **Representation** — side-list `transparentColorIds: string[]` (**building
  this**, mirrors `finishOverrides`) vs an on-color `transparent?: boolean`. Side-
  list keeps color objects and old-payload back-compat clean.
- Multiple background colors allowed (a `Set`), since a mural can have several
  bare-wall shades.

## 4. Verification

- `npm run typecheck`, `npm run test`, `npm run build`, `npm run lint` (repo root).
- New/updated tests: `editorPersistence` round-trip (`buildPaletteJson` +
  `hydrateFromProject` preserve `transparentColorIds`); `apps/api` schema test
  accepts the new field and rejects malformed (non-string / >200).
- Headless Chrome (Playwright cache) on `docs/example_art/IMG_2953.jpg`: flag a
  color → assert it drops from the estimate/can total and the flatten preview
  shows show-through.
- Manual on the Pages preview: (1) estimate excludes it, (2) preview show-through,
  (3) PDF maquette image show-through + can-list excludes it, (4) cloud save +
  reload persists the flag, (5) device draft save/restore persists the flag.

## 5. Open questions

1. Grid visibility of flagged colors — badge-and-keep (planned) vs hide. Confirm.
2. Any label/wording preference for the toggle + PDF ("Background — no paint")?

Additive optional field → **no schema migration or manual version bump** required;
old projects load with an empty set.

## 6. Implemented (2026-07-02)

- Added `schemaVersion` to the palette JSON template (web `apiClient.PaletteJson`,
  api `types.PaletteJson`, `schemas/project.paletteJsonSchema`), stamped via the new
  `PALETTE_SCHEMA_VERSION = 1` in `editorPersistence.ts`. Optional on read →
  legacy documents (no field) treated as v1.
- `transparentColorIds` threaded: editor `Set<string>` state + `toggleTransparentColor`,
  `paintablePalette` filter feeding the `containerPlan` + `fieldSheetModel` memos,
  `flattenImageToPalette` alpha-0 show-through, cleared in all three reset paths,
  serialized in `buildEditorSnapshot` (existing ids only) + `SavedMergePlan`,
  restored in `restoreSavedChoices` + the cloud hydrate effect. API schema validates
  it (`z.array(z.string().min(1).max(100)).max(200).optional()`).
- UI: per-swatch "Mark as background" toggle; flagged cards get a checkerboard
  swatch + "Bare wall — excluded from the paint estimate" note and hide the
  finish/coats/estimate controls.
- Verified: typecheck (all workspaces), test (web 59 pass incl. new schema-version +
  transparentColorIds round-trip + reject tests; api 60), build, lint. Headless
  Chrome on IMG_2953: flagging the dominant color dropped the 1-gal can from the
  estimate; checkerboard + badge render; un-flag restores; guest device-draft
  save→reload→re-upload→restore round-trips the flags.
- **Not verified live:** signed-in cloud save→reload persistence needs the API +
  Mongo running (not available locally). The wire contract is covered by the
  `buildPaletteJson → hydrateFromProject` unit round-trip and the schema test; the
  hydrate-effect wiring is in place. Flag for a reviewer with the backend up.
