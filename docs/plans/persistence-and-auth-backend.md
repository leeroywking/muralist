# Persistence and Auth Backend — Plan

Task summary: Ship the persistence + auth backend for user projects end-to-end — Fastify API with Better Auth, MongoDB storage, tier-gated JSON CRUD endpoints over palette + sanitized image + thumbnail artifacts, and the web client's upload sanitization pipeline. Deployed on DigitalOcean App Platform + DO Managed MongoDB fronted by Cloudflare Free.

Supersedes the 2026-04-23 scoping review artifact previously at this path. Decisions from that review are captured in §3's "already-answered" list below.

## 1. Step-By-Step Plan

Recommended sequencing: three sequential PRs inside this round (see §3 Ambiguity A). Each PR ships its own tests and the doc updates it touches.

### Infrastructure (provision before code lands in staging)

1. **DO Managed MongoDB** — single-node, 1 GiB RAM (~$15/mo). Provision, note connection URI, enable TLS, allowlist the App Platform egress IPs.
2. **DO App Platform service** — Shared Fixed, 1 vCPU / 512 MiB ($5/mo prototype floor; $12 "comfortable" tier available when multi-instance is needed). Build `npm run build --workspace @muralist/api`, run `npm run start --workspace @muralist/api`.
3. **Cloudflare zone** — front the App Platform endpoint behind a CF-proxied domain. SSL = Full (Strict). Add the single rate-limit rule: match `http.request.uri.path matches "^/api/"`, scope per client IP, threshold `120 req/min`, action `block for 1m`.
4. **Environment variables** on App Platform: `MONGO_URI`, `BETTER_AUTH_SECRET` (long random), `APP_BASE_URL`, and per-provider OAuth `CLIENT_ID` / `CLIENT_SECRET` pairs (Google, Apple, Facebook, Adobe).

### `packages/config`

5. Add `config/tiers.yaml`:
    ```yaml
    tiers:
      - id: free
        projectLimit: 3
      - id: paid
        projectLimit: null   # unlimited
        subscriptionOptions:
          - kind: recurring
          - kind: one_time
            windowDays: null   # open item — see §5
    ```
6. Add `config/upload-limits.yaml`:
    ```yaml
    sanitizedImage:
      maxBytes: 25600
      longEdge: 640
      jpegQuality: 0.8
    thumbnail:
      maxBytes: 8192
      longEdge: 192
      jpegQuality: 0.8
    contentTypeAllowlist: ["image/jpeg", "image/webp"]
    ```
7. Add `packages/config/src/tiers.ts` — zod-validated loader. Export `loadTierConfig()`, `resolveTier(id: "free" | "paid")`, and `TierConfig` / `TierDefinition` types.
8. Add `packages/config/src/uploadLimits.ts` — same pattern; export `loadUploadLimits()` and `UploadLimits` type.
9. Tests in `packages/config/test/`: load success path, load failure on malformed YAML, invalid enum values, missing-required-field failures.

### `apps/api` — dependencies and setup

10. Install runtime deps: `better-auth`, `@better-auth/mongodb`, `mongodb`, `@fastify/cookie`, `@fastify/csrf-protection`, `@fastify/cors`, `zod`, `fastify-plugin`. Dev deps: existing `tsx` + `@types/node`.
11. Add `apps/api/src/db.ts` — Mongo connection + collection bootstrap. Ensure indexes at startup:
    - `users` — unique on `sub`, index on `email`.
    - `projects` — index on `userId`, compound `{ userId: 1, status: 1, updatedAt: -1 }` for dashboard listing.
    - `project_thumbnails` — compound `{ userId: 1, status: 1, lastViewedAt: -1 }`.
    - `sessions` — managed by Better Auth adapter; TTL on `expiresAt`.
12. Add `apps/api/src/auth.ts` — Better Auth config:
    - Providers built-in: Google, Apple, Facebook.
    - Adobe wired via the `genericOAuth` plugin (`providerId: "adobe"`, Adobe IMS discovery URL, client id/secret from env).
    - Session store: Mongo adapter.
    - Cookie: HttpOnly, Secure, SameSite=Lax, scoped path `/`.
    - Account-linking: auto-link on matching email (per §3 already-answered).
    - `trustedOrigins: [APP_BASE_URL]`.
13. Mount Better Auth handlers under `/api/auth/*` in `apps/api/src/server.ts`. Register `@fastify/cookie`, then `@fastify/csrf-protection` (cookie named `csrf-token`, header `X-CSRF-Token`), then Better Auth.

### `apps/api` — schemas and types

14. Add `apps/api/src/schemas/project.ts` — zod schemas for every inbound payload:
    - `createProjectSchema` — `{ name (≤200 chars), palette, image (base64), thumbnail (base64) }`.
    - `updatePaletteSchema`, `updateImageSchema`, `updateThumbnailSchema`, `updateMetadataSchema`.
    - Palette bounds: color hex format, coverage values in `[0, 1]`, coverage sum within ε of 1.0, mix-recipe fractions sum within ε of 1.0, name length caps, notes length cap (2000 chars), wall dimensions positive and finite.
15. Add `apps/api/src/types.ts` — `SessionUser`, `ProjectDoc`, `ThumbnailDoc`, `LimitState`.

### `apps/api` — image pass-through validation

16. Add `apps/api/src/imageValidation.ts` — pure, zero image libraries:
    - `validateImagePayload(base64, kind: "sanitized" | "thumbnail"): { ok: true, bytes: Buffer } | { ok: false, reason: ErrorCode }`.
    - Steps: base64 integrity (regex + length vs configured cap), decode to Buffer, magic-byte check (`FF D8 FF` or `RIFF ... WEBP`), final byte-length cap. **Never calls Sharp / libvips / ImageMagick.**
    - `type ErrorCode = "INVALID_BASE64" | "OVER_SIZE" | "BAD_MAGIC_BYTES" | "UNSUPPORTED_TYPE"`.
17. Unit tests in `apps/api/test/imageValidation.test.ts` covering every `ErrorCode` path + happy paths for both JPEG and WebP.

### `apps/api` — middleware and plugins

18. Add `apps/api/src/plugins/requireUser.ts` — Fastify plugin decoration: `request.user` resolved from Better Auth session or 401.
19. Add `apps/api/src/plugins/tierEnforcement.ts` — Fastify plugin exposing `request.limits` with `{ activeProjectCount, atLimit, overLimit }` computed from a Mongo aggregation on `projects` filtered by `userId`. Caches per-request. Also provides `assertWriteAllowed()` which throws 403 when `overLimit` is true, except delete (caller opts in).
20. CORS plugin — scoped to `APP_BASE_URL` only, `credentials: true`. Replaces the current `origin: true` in `apps/api/src/server.ts`.

### `apps/api` — routes

21. `apps/api/src/routes/me.ts`:
    - `GET /me` — `{ tier, effectiveTier, projectLimit, activeProjectCount, atLimit, overLimit, linkedProviders[], proSettings }`. All fields server-computed.
    - `PATCH /me/pro-settings` — validates body against `proSettingsSchema`, updates `users.$.proSettings`, returns 204.

22. `apps/api/src/routes/projects.ts`:
    - `POST /projects` — requires user. Validates `createProjectSchema`. Validates image + thumbnail via `imageValidation.ts`. Applies one-grace-save rule: if `activeProjectCount === projectLimit`, allow the save and let the tier-enforcement plugin flip the user into read-only afterward; if `activeProjectCount > projectLimit`, reject with 403. Writes `projects` doc + `project_thumbnails` doc inside a Mongo transaction.
    - `GET /projects` — reads `project_thumbnails` only. Query param `?status=active|trashed` (default `active`). Returns `{ id, name, thumbnail, lastViewedAt, createdAt, status }[]`.
    - `GET /projects/:id` — reads full `projects` doc. 404 if not owned by `request.user`; 410 if trashed and `?includeTrashed` absent. Touches `lastViewedAt` in both collections.
    - `PATCH /projects/:id/palette` — `assertWriteAllowed()`. Version-conditional update (expects `If-Match` header carrying last-known version; returns 409 on mismatch). Bumps version + `updatedAt`.
    - `PATCH /projects/:id/image` — `assertWriteAllowed()`. Pass-through validation. Writes image bytes to `projects.$.sanitizedImage`.
    - `PATCH /projects/:id/thumbnail` — `assertWriteAllowed()`. Pass-through validation. Writes bytes to `project_thumbnails.$.thumbnail`.
    - `PATCH /projects/:id/metadata` — `assertWriteAllowed()`. Updates `name`, `notes`, wall dimensions.
    - `DELETE /projects/:id` — always allowed (escape valve). Sets `status: "trashed"`, `deletedAt: now` in both collections.
    - `POST /projects/:id/restore` — must be within 14 days of `deletedAt` (else 410 `GRACE_EXPIRED`). Restores `status: "active"`. Re-runs tier check; if restoring pushes over limit, user enters read-only mode (no one-grace-save — restore isn't a new work surface).
    - `POST /projects/:id/viewed` — bumps `lastViewedAt` in both collections without other mutations (PDF-export hook from the web client).

23. `apps/api/src/routes/export.ts`:
    - `GET /export` — streams `application/json` attachment containing `{ schemaVersion, exportedAt, projects: [{ …fullDoc, thumbnail, sanitizedImage }] }`. Includes active + trashed.

24. `apps/api/src/routes/account.ts`:
    - `DELETE /account` — sets `users.$.deletionPendingAt = now`. Returns `{ deletionAt: now + 30d }`.
    - `POST /account/delete-cancel` — clears `deletionPendingAt`.
    - The actual purge is lazy-evaluated on each `/me` request — if `deletionPendingAt` + 30d ≤ now, the handler purges `projects`, `project_thumbnails`, sessions, and finally the `users` doc, then 401s. (See §5 open question on scheduled-vs-lazy.)

25. `apps/api/src/server.ts` — register order: cookie → CSRF → CORS → db connection → Better Auth → requireUser/tier plugins → routes. Keep the existing `/health`, `/api/auth/capabilities`, `/api/paint-brands`, `/api/estimate` endpoints — they're still in scope, just augmented with the new routes.

### `apps/api` — tests

26. Integration tests (Fastify `inject`-based):
    - `/me` returns server-computed flags correctly at 0 projects, 3 projects, 4 projects.
    - Guest = 401 on every write, including `POST /projects`, all `PATCH /projects/*`, `DELETE /projects/:id`.
    - Tier gate: 3 creates succeed; 4th succeeds with grace-save and flips user to `overLimit`; 5th rejected 403.
    - Read-only mode blocks `PATCH /projects/*` but allows `DELETE`; after delete, user returns to `active` mode.
    - Trash + restore within 14 days works; restore past 14 days returns 410.
    - Pass-through image validation rejects wrong magic bytes, oversized payloads, malformed base64 — each with the specific `ErrorCode`.
    - Palette schema bounds reject invalid hex, coverage-sum over ε, name too long.
    - Provider linking: second provider matching existing email adds to `linkedProviders[]`, does not create a duplicate user.
    - Session revocation: `DELETE /api/auth/sessions/:id` invalidates that session specifically, leaves others.
    - Version-conditional palette writes: missing `If-Match` → 428; stale `If-Match` → 409; current → 200.

### `apps/web` — client sanitization pipeline

27. Add `apps/web/app/uploadPipeline.ts`:
    - `async function sanitizeUpload(file: File, limits: UploadLimits): Promise<{ sanitized: Blob, thumbnail: Blob }>`.
    - Extension allowlist (`.jpg`, `.jpeg`, `.webp`).
    - Client-side magic-byte check on the first 16 bytes.
    - `createImageBitmap(file)` → draw into OffscreenCanvas at `limits.sanitizedImage.longEdge`, `canvas.convertToBlob({ type: "image/jpeg", quality: limits.sanitizedImage.jpegQuality })`.
    - Second pass for the thumbnail at `limits.thumbnail.longEdge`.
    - Returns both Blobs; caller handles base64 encoding and the API call.
28. Add `apps/web/app/apiClient.ts`:
    - `fetch`-based wrappers for the new endpoints. Reads the `csrf-token` cookie, sends as `X-CSRF-Token` header on mutating requests.
    - `credentials: "include"` so Better Auth cookies flow.
    - Surfaces 401/403 explicitly; consumer decides redirect / message.
    - Base64 encoding helpers for Blob → data URI stripped to raw base64.
29. Unit tests for `uploadPipeline.ts` behavior where testable without a real browser (magic-byte path; size-cap path). Canvas work is exercised by the future UI session.
30. **Do not integrate into `apps/web/app/PrototypeApp.tsx` this round.** Per the UI-skeleton rule, drop a single `// TODO(ui-round): wire uploadPipeline + apiClient into the upload flow` comment at the file's upload hook site. The existing client-side-only upload flow continues working unchanged.

### Docs

31. New `docs/RETENTION_POLICY.md` — short, covers:
    - 14-day trash recovery for user-initiated deletes.
    - Guaranteed retention (no auto-expiry) for all tiers; over-limit users enter read-only but keep their data.
    - Data-export endpoint: what's included, how to request.
    - Account deletion: 30-day in-app confirm window, what's purged.
    - Pass-through image validation stance — we never decode user images on our servers.
    - No transactional email — all security-adjacent notifications surface in the Settings view.
    - Sub-processors list: DigitalOcean (hosting + DB), Cloudflare (edge), OAuth providers (Google/Apple/Facebook/Adobe).

32. Update `docs/ARCHITECTURE.md`:
    - Replace "DynamoDB-first data model" section with "Document-shaped data model on MongoDB" — reference the `users`, `projects`, `project_thumbnails`, `sessions` collection plan.
    - Replace "AWS Readiness" with "DigitalOcean + Cloudflare" — the stack we actually deploy on.
    - Keep the aggregate-shaped-entities guidance; only the store name changes.

33. Update `AGENTS.md`:
    - "Flag before implementing" rule: `"... the data model is DynamoDB-first"` → `"... the data model is document-shaped on MongoDB"`.
    - "Read before editing" — add `docs/RETENTION_POLICY.md` to the required reads.
    - Add a `apps/api` task-adjacent read pointing at `apps/api/src/auth.ts` and `apps/api/src/imageValidation.ts` for auth/upload work.

34. Update `ROADMAP.md`:
    - Phase 2 "Basic auth" → shipped by this round.
    - Phase 2 "User-scoped paint brand preferences" → pinned as paywall-gated future work (user paint library bucket per `project_monetization_principle`).
    - Remove the "Multi-wall projects" line — shelved.

### Not touched

- `apps/mobile/**` — expected ground-up mobile build later; this round does not wire the API into Expo.
- `packages/core/**` — no business-logic changes.
- `apps/web/app/PrototypeApp.tsx` and other web UI beyond the new `uploadPipeline.ts` + `apiClient.ts` files; UI integration is deferred to a separate session per the UI-skeleton rule.
- `.github/workflows/**`, root + workspace `package.json` scripts (except adding api deps), `tsconfig*.json`, `apps/web/next.config.mjs` — all hands-off per `AGENTS.md`.
- `config/paint-brands.yaml` — unchanged.

## 2. AGENTS.md Flag Check

- **Guest-mode persistent write boundary: applies.** Every write endpoint must enforce `session.kind === "user"`. Implemented as the `requireUser` middleware (step 18) and verified by the guest-401 integration test (step 26). No endpoint bypasses.
- **CORS widening: applies.** API switches from `origin: true` to a scoped allowlist keyed on `APP_BASE_URL` (step 20). Credentials are enabled for cookie-based sessions. Flagged before implementation for explicit sign-off.
- **OAuth provider tokens: applies.** Better Auth holds provider tokens server-side in the Mongo `sessions` collection; never returned in API responses, never stored in client-accessible storage (step 12). Verified by inspection of the session payload in integration tests.
- **DynamoDB-first modeling: applies with amendment.** This round explicitly updates `AGENTS.md` (step 33) to reflect MongoDB while preserving the "no relational joins across aggregates" spirit. Design stays aggregate-shaped.
- **New public endpoint / rate limiting: applies.** All new app endpoints are authenticated-only (guest 401 on writes). The OAuth init / callback endpoints are inherently public but delegated to Better Auth. Rate limiting is handled at the Cloudflare edge (single rule, step 3). Server-side schema validation on every inbound payload (step 14).
- **Upload validation: applies.** Pass-through validation with magic-byte + content-type + size + base64-integrity checks (step 16). No image-parsing library in the app process. Tests in step 17.
- **Committed user-scoped data: applies.** `config/tiers.yaml` and `config/upload-limits.yaml` are global defaults only. User-scoped brand overrides (future feature) will live in Mongo, not the repo.
- **`packages/core` purity: N/A.** No core changes in this round.
- **Hands-off surfaces: not touched.** `.github/workflows/**`, root scripts, tsconfig, `next.config.mjs` — unchanged.

Security context (per `docs/SECURITY_REVIEW.md`): known high-severity advisories in Fastify and Expo remain tracked; this round does not silently upgrade either framework. Fastify stays on the current major line with patch-level updates only.

## 3. Ambiguity Check

**Ambiguity A — PR sequencing inside the round.** One bundled PR vs three sequential PRs inside the same backend round.
- Option A (chosen): Three sequential PRs. PR 1 = infra provisioning + `packages/config` + docs drafts. PR 2 = Better Auth wiring + `/me` + `/api/auth/*`. PR 3 = projects CRUD + export + account deletion + tests + doc finalization. Each PR ships green CI before the next starts.
- Option B: One bundled PR (~2000 lines). Simpler to track, much harder to review, one bad merge rolls back the whole round.
- Decision: Option A. Each PR is independently reviewable and ships with its own test coverage.

**Ambiguity B — Non-subscription reduced-rate window.** User answered 2026-04-23: fixed time window, configurable, number TBD.
- Decision: ship the config *shape* now — `config/tiers.yaml` carries `subscriptionOptions[].one_time.windowDays` as a field that's `null` until the billing-design round picks a real value. Code that depends on it treats `null` as "one-time purchase not available yet."

**Ambiguity C — CSRF token delivery.** Fastify's CSRF plugin can deliver via cookie, header, or dedicated endpoint.
- Decision: standard double-submit pattern. Cookie `csrf-token` (not HttpOnly so JS can read it), same value echoed as `X-CSRF-Token` header on mutating requests. Matches Better Auth expectations and works with Next.js server actions.

Already-answered ambiguities from the 2026-04-23 scoping review (captured for the PR trail):

- **Cloud:** DO App Platform + DO Managed MongoDB + Cloudflare Free. AWS and Oracle ruled out.
- **Data layer:** MongoDB. Not Postgres+JSONB.
- **Auth library:** Better Auth self-hosted. Google / Apple / Facebook built-in; Adobe via `genericOAuth` plugin.
- **Session mechanism:** HttpOnly cookie + CSRF on mutating endpoints. Token-in-localStorage rejected for the web client; may be revisited for mobile.
- **Stored artifacts per project:** palette JSON (carrying reversible merge operations) + sanitized reduced image + thumbnail. Original source image never leaves the browser.
- **Collection split:** `projects` (palette + main image) and `project_thumbnails` (dashboard-fast) are separate collections.
- **Endpoint split:** palette, image, thumbnail, metadata are independent PATCH endpoints.
- **Server validation model:** pass-through with magic-byte boundary checks. No image parser in the app process.
- **Payload encoding:** JSON with base64 image fields. Not multipart.
- **Tier limits:** free = 3 projects, paid = unlimited. One-grace-save on save-into-limit. Over-limit users enter a unified read-only mode.
- **Server-computed limit state:** `atLimit` / `overLimit` on the user doc, returned by `/me`. Clients never derive from the projects list.
- **Rate limiting:** single Cloudflare edge rule (120 req/min/IP on `/api/*`). No app-level limits this round.
- **Lifecycle:** no auto-expiration. 14-day trash recovery on user-initiated delete. Retention is guaranteed for all tiers.
- **Email:** dropped entirely. Recent sign-ins list and in-app confirm flows replace it.
- **Monetization principle:** cost-axis + risk-budget + dev-readiness. User paint library (custom brands, coefficients, calculator, inventory, mixing, aging) is the paid bucket.
- **UI:** skeleton-only this round. Projects view, Settings view, read-only banner, greyed paid-only affordances, Trashed-projects surface — all deferred to a separate UI session.

## 4. Verification Approach

Run from repo root after each of the three PRs:

- `npm run typecheck`
- `npm run test`
- `npm run build`
- `npm run lint`

Workspace-scoped for faster iteration during development:

- `npm run test --workspace @muralist/api`
- `npm run test --workspace @muralist/config`

Integration tests (step 26) cover the boundary matrix. Unit tests cover `imageValidation.ts` and `packages/config` loaders.

Manual verification against the DigitalOcean staging deploy once each PR's CI is green:

**PR 1 (infra + config):** confirm `/health` and existing endpoints still respond through the Cloudflare domain; confirm the Cloudflare rate-limit rule fires at 120 req/min/IP on `/api/*`; confirm `config/tiers.yaml` and `config/upload-limits.yaml` load successfully at boot.

**PR 2 (auth):** hit `/api/auth/sign-in/google` in a browser; complete the round-trip; confirm session cookie is set (HttpOnly, Secure, SameSite=Lax). Hit `/me`; confirm `{ tier: "free", activeProjectCount: 0, atLimit: false, overLimit: false }`. Sign out; confirm `/me` returns 401. Sign in via Apple using an email that matches the Google-signed account; confirm `linkedProviders[]` lists both. Repeat for Adobe via the generic plugin. `DELETE /api/auth/sessions/:id`; confirm that specific session is revoked while others persist.

**PR 3 (CRUD + export + account):** using a test account, `POST /projects` with a sanitized image + thumbnail; confirm 201 with the new project id. `GET /projects`; confirm the tile-shape projection (no image bytes). `GET /projects/:id`; confirm full record with image bytes. `PATCH /projects/:id/palette`; confirm image bytes unchanged. `PATCH /projects/:id/image`; confirm palette unchanged. Hit the limit: create 3, then 4th with grace-save, then 5th rejected 403 `OVER_TIER_LIMIT`. Delete one; confirm read-only mode clears. Trash one and `POST /projects/:id/restore` within the window; confirm restored. Simulate expiry and confirm restore returns 410. POST a non-JPEG payload as `sanitizedImage`; confirm 400 `BAD_MAGIC_BYTES`. POST an oversized base64; confirm 400 `OVER_SIZE`. `DELETE /account`; confirm `deletionPendingAt` set. `POST /account/delete-cancel`; confirm cleared.

No user-visible UI work in this round, so the AGENTS.md "preview must load the new behavior" rule is non-binding here. The backend change is reviewed via the API verification matrix above.

## 5. Open Questions

1. **Non-subscription window duration.** Configurable per the 2026-04-23 user answer; concrete number deferred to the billing-design round that ships Stripe.
2. **Rate-limit numbers.** 120 req/min/IP on `/api/*` is the initial setting; revisit after staging traffic data if genuine human usage trips it.
3. **Regional data residency.** No current user-facing promise. DO Managed MongoDB region is picked at provision time and stays put; flag if a GDPR-style promise becomes necessary.
4. **Account-deletion scheduling.** Plan uses lazy evaluation on `/me` (step 24). If you want a firmer guarantee (purge runs on time even for users who never sign in again), we'd add a scheduled job; flagging because it's a meaningful architecture choice.
5. **CSRF cookie lifetime.** Default is per-session. Shorter (rotating mid-session) is more defensive but adds complexity; flagging for later hardening.
6. **Better Auth secret rotation.** Prototype uses a single `BETTER_AUTH_SECRET`; rotation strategy and downtime impact are open for production hardening.

## 6. Session Handover — 2026-04-23 / 2026-04-24

Work shipped beyond the three-PR plan above, captured so the next session
can pick up cold. All commits land on `main` via `feat/persistence-auth-backend`
(merged fast-forward `2026-04-24`).

### Deploy topology

- DO App Platform app `9d86ef02-3b5c-4df4-a9cb-d8c8abbbc4ce` (`muralist-api`).
- Both components (`api` Fastify service + `web` Next static site) now
  track `branch: main` with `deploy_on_push: true` per `.do/app.yaml`.
  The spec was applied via `doctl apps update --spec .do/app.yaml` at the
  switchover — DO does NOT read the yaml from git automatically.
- Domains: `muraliste.com` → web, `api.muraliste.com` → api (routing via
  `ingress.rules`). Cloudflare fronts both; api cookies are scoped to
  `api.muraliste.com`.
- Mongo: DO Managed MongoDB cluster
  `201ae840-f9d9-4eff-bfac-9340d35412b2`, trusted-sources allowlist holds
  only the app UUID (`9d86ef02-…`).

### What actually shipped this round beyond the base plan

- **Sign-in UI** (`apps/web/app/signin/page.tsx`,
  `apps/web/app/SignInButtons.tsx`, `apps/web/app/HeaderSessionLink.tsx`).
  Google live; Apple/Facebook/Adobe buttons present but greyed until
  credentials land (`docs/OAUTH_PROVIDER_SETUP.md`).
- **Projects dashboard** (`apps/web/app/projects/page.tsx`,
  `apps/web/app/ProjectsDashboard.tsx`). Tile grid, delete with 14-day
  trash copy, over-limit banner, empty state.
- **Editor ↔ backend wiring** (`apps/web/app/editorPersistence.ts`,
  editor integration in `apps/web/app/PrototypeApp.tsx`). Upload →
  sanitize → cloud-save; `?project=<id>` hydration; `If-Match`
  version-conditional palette updates; 409 reload/save-as-new UI.
- **Site nav**: `Projects` link in the header for signed-in users.

### Fixes landed this session (post-compaction)

- **`/projects` envelope** — client expected a bare array, server returns
  `{ projects: […] }`. `listProjects` now unwraps.
- **Sign-out 400** — Better Auth's `/api/auth/sign-out` goes through
  Fastify's JSON parser which rejects empty bodies. Client now sends `{}`.
- **CSRF cross-subdomain** — web origin (`muraliste.com`) cannot read
  cookies scoped to the api origin (`api.muraliste.com`), so the
  cookie-read path always returned null. Client now fetches `GET
  /csrf-token` on first mutating request, caches the token in memory,
  refreshes on 403 `FST_CSRF_*`. No server env change needed.
- **localStorage-beats-server collisions** — `getMe().proSettings` was
  fetched but never applied; localStorage was the only read path. For
  signed-in users: `proSettings` now hydrates from `/me` and auto-syncs
  via `PATCH /me/pro-settings` on change; the on-device save/restore
  buttons and "Remember on device" checkbox are hidden.
- **Image caps** —
  - Accepted formats now include `.png` on the client (server still
    only sees JPEG after sanitizer re-encode).
  - `sanitizedImage.maxBytes`: 25 KB → 200 KB → 400 KB.
  - `thumbnail.maxBytes`: 8 KB → 16 KB → 24 KB → 64 KB.
  - `base64ImageSchema.max(chars)`: 50k → 300k → 600k (the byte-accurate
    check lives in `imageValidation.ts`; Zod is just a sanity bound).

### Known open items for the next session

- **Draft-stash for unauthenticated save → sign-in** *(designed, not built)*.
  Current behaviour: signed-out user clicks "Save to my account" → OAuth
  redirect → returns with session but in-memory editor state is lost. The
  plan is a localStorage draft keyed on `muralist.pending-cloud-save`
  written before the sign-in redirect and a restore-banner on `/` when the
  user returns authenticated. Inline banner, explicit-click scope, 60 min
  TTL, cleared on sign-out.
- **`/api/upload-limits` endpoint not wired**. `apps/web/app/editorPersistence.ts`
  carries a hardcoded `DEFAULT_UPLOAD_LIMITS` that must be kept in sync
  with `config/upload-limits.yaml`. Low-cost follow-up.
- **`email` not on `/me` response**. Editor project-name default falls
  back to filename because the client can't read it. Small backend add.
- **Google OAuth "Code Challenge must be base64 encoded"** intermittent
  error seen earlier; unresolved. Google side reported the redirect URI
  was configured; our PKCE is spec-compliant. Watch for recurrence.
- **Settings page / account linking UI** — deferred; see
  `docs/plans/web-ui-post-backend.md`.

### File-level touchpoints added in this round (grep anchors)

- `apps/web/app/apiClient.ts` — in-memory CSRF cache, `updateProSettings`,
  envelope unwrap for `listProjects`, `{}` body on sign-out.
- `apps/web/app/PrototypeApp.tsx` — proSettings hydration from `/me`,
  gated localStorage reads/writes, `isSignedIn` prop on
  `ProSettingsPanel`.
- `apps/web/app/uploadPipeline.ts` — `.png` + PNG magic bytes.
- `config/upload-limits.yaml` — current caps (400 KB / 64 KB).
- `apps/api/src/schemas/project.ts` — base64 char cap at 600k.
- `.do/app.yaml` — both components track `main`.

### Deploy-time gotcha seen 2026-04-24

Applying `.do/app.yaml` directly via `doctl apps update --spec .do/app.yaml`
wiped `MONGO_URI` and `BETTER_AUTH_SECRET` on the app, because the
committed yaml declares those fields as `type: SECRET` with no `value:`.
Every subsequent deploy failed at phase 5/7 with `Missing required
environment variables`; DO auto-rolled back each time, which was what
kept the site serving but also masked the real problem until the next
deploy attempt failed identically. Recovery: build a temporary spec file
in `~/` that copies `.do/app.yaml` but inlines real `value:` fields for
each SECRET, run `doctl apps update --spec ~/tmp.yaml`, then delete the
temp file. Never apply the repo's yaml directly for secret-bearing keys.
