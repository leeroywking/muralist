# Web UI — Post-Backend Plan

Task summary: Build the `apps/web` user-facing surfaces that consume the
persistence + auth backend shipped on `feat/persistence-auth-backend`. The
backend is live at `https://muralist-api-vbgh6.ondigitalocean.app`; this
round wires the existing `apiClient.ts` + `uploadPipeline.ts` into real
pages users can click.

Supersedes nothing. Created 2026-04-23 as a handoff stub per the
UI-skeleton rule that kept UI work out of the backend session.

## 1. Step-By-Step Plan

### `apps/web/app/signin` (new route)

1. Create `apps/web/app/signin/page.tsx`.
   - Three provider buttons: Google, Apple, Facebook, Adobe.
   - Only light up (enabled) the providers `GET /api/auth/capabilities` reports
     as active. That endpoint currently hardcodes `["google","apple","facebook"]`
     in `packages/core/getAuthCapabilities()` and omits `adobe` — fix the core
     function to either accept the enabled list as a parameter or expose it
     from `apps/api` as an endpoint.
   - Button click → call `apiClient.signInSocial(provider, callbackURL)` and
     `window.location = response.url`.
   - Show a loading state while the POST is in flight; show a generic error if
     the POST returns non-2xx.

2. Create `apps/web/app/auth/callback/page.tsx` **(optional — can be deferred)**.
   - Purely a landing page after Better Auth's callback has set the session
     cookie. Responsible only for calling `GET /me` to confirm session is
     live, then redirecting to the Projects dashboard.
   - `callbackURL` in the sign-in POST can point to this route so the UX is
     clean; if omitted, Better Auth default behaviour is fine.

### `apps/web/app/projects` (new route — the Projects dashboard)

Per `docs/plans/persistence-and-auth-backend.md` §2.6 skeleton.

3. Route at `apps/web/app/projects/page.tsx`. Gated on authenticated session
   (server-side check via `apiClient.getMe()` in a Server Component, or
   client-side redirect on 401).

4. Calls `apiClient.listProjects(status)` and renders a tile grid:
   - Each tile shows the thumbnail (base64 → data URL), name, `lastViewedAt`
     relative time.
   - Tile actions: **Open** (routes to the editor), **Rename**,
     **Duplicate** (client-composed: `getProject` + `createProject` per
     plan §3.4), **Delete** (confirm prompt → `deleteProject` → refresh list).
   - Empty state for new users.
   - **Read-only banner across top when `me.overLimit === true`** — noticeable
     but non-obscuring per §2.6 user feedback ("I don't want to piss users off,
     I just want them to know why certain things don't work").
   - `?status=trashed` query param toggles a "Trashed (14-day retention)"
     filter that lists trashed projects + shows Restore buttons
     (`apiClient.restoreProject(id)`).

5. Server-computed limit awareness: the grid's "+ New project" CTA is
   greyed when `me.atLimit === true && me.effectiveTier === "free"` (one-grace-save
   still allowed — the CTA stays clickable UNTIL `overLimit === true`).

### `apps/web/app/settings` (new route — the Settings view)

Per plan §2.6.

6. Route at `apps/web/app/settings/page.tsx`. Gated on authenticated session.

7. Sections:
   - **Account**: email (read-only from `/me.email`), linked OAuth providers
     (show `/me.linkedProviders[]`; note it's currently always `[]` until the
     Better Auth `databaseHooks.account.create.after` hook is wired — see
     `apps/api/src/types.ts` TODO).
   - **Tier & usage**: `activeProjectCount of projectLimit` (e.g. "2 of 3
     projects"). "Subscription: free" / "Subscription: paid" when billing
     lands. Greyed paid-feature prompts per plan §2.5:
     - "Custom paint brands — paid feature" (greyed button)
     - "User-scoped brand coefficients — paid feature" (greyed button)
     - "Paint inventory — paid feature" (greyed button)
   - **Pro Settings**: classifier sensitivity preset (default **Conservative**
     per plan §2.5 + §2.6), mix coverage %, residual threshold. Changes
     `PATCH /me/pro-settings` via `apiClient.updateProSettings(patch)`. This
     replaces the `localStorage`-only Pro Settings currently in
     `apps/web/app/PrototypeApp.tsx`.
   - **Data export**: "Download my data" button → `apiClient.exportAllData()`
     → trigger browser download of the JSON blob.
   - **Account deletion**: "Delete account" button → confirmation dialog
     explaining the 30-day grace window → `apiClient.deleteAccount()` →
     show pending-deletion state + "Cancel deletion" button that calls
     `apiClient.cancelAccountDeletion()`.
   - **Recent sign-ins / devices**: **deferred** (matches the backend's
     current state — session listing endpoint exists but hasn't been
     wired as a UI surface; the backend response needs a cross-check first).

### Upload flow wiring in the existing PrototypeApp

8. Find the `// TODO(ui-round):` comment in `apps/web/app/PrototypeApp.tsx`
   (seeded during the backend session). That's the upload hook site.

9. Replace the current client-only flow:
   - On file pick: call `sanitizeUpload(file, uploadLimits)` from
     `apps/web/app/uploadPipeline.ts` to get `{ sanitized, thumbnail }` Blobs.
   - `await blobToBase64(sanitized)` + `await blobToBase64(thumbnail)`.
   - If the user is signed in: `apiClient.createProject({ name, palette, image, thumbnail })`.
   - If guest: fall back to the current `localStorage`-only SavedMergePlan
     path.
   - On `OverLimitError` from `createProject`: show inline "You've hit your
     limit of N projects — open Settings or delete one to make room."

10. Fetch `/api/upload-limits` OR embed the limits on `/me` response
    (which could surface them — consider adding `limits.sanitizedImage`
    etc. to the `/me` response shape). The web app currently has no way to
    know the configured caps.

### Session state + route gating

11. Add a small React context `SessionContext` in `apps/web/app/session.tsx`
    that calls `apiClient.getMe()` on mount, re-fetches on focus, and exposes
    `{ me, loading, isAuthed, refresh }`. Wrap the root layout in it.

12. Redirect logic: when `apiClient` throws `UnauthenticatedError` on any
    call, clear context and route to `/signin`. When a page is gated and
    the session is missing, push to `/signin?returnTo=<current-path>`.

### Header / navigation updates

13. Existing `PrototypeApp.tsx` header currently doesn't have auth affordances.
    Add a small top-right section:
    - Signed out: "Sign in" link → `/signin`.
    - Signed in: avatar / initials + dropdown with "Projects", "Settings",
      "Sign out". Sign out → `apiClient` call to Better Auth's sign-out
      endpoint (POST to `/api/auth/sign-out`), clear session context,
      redirect to `/`.

### Capabilities-endpoint cleanup

14. `packages/core`'s `getAuthCapabilities()` currently hardcodes
    `["google","apple","facebook"]` and omits `adobe`. Update either to:
    - Accept `enabledProviders: string[]` as a param, passed from the API
      server at call time (trusts the runtime-derived list), OR
    - Return a static list that at least includes `adobe` and document that
      the real "which buttons to show" logic is a separate UI call.
    The first is cleaner once the web app has an API surface for it.

### Not touched

- `apps/api/**` — backend is complete for this round; only the Apple
  config change when that provider's creds arrive (see
  `docs/OAUTH_PROVIDER_SETUP.md`).
- `apps/mobile/**` — separate future round.
- `.github/workflows/**`, root/workspace `package.json` SCRIPTS (except
  adding deps if tests need them), `tsconfig*.json`,
  `apps/web/next.config.mjs`.
- `packages/core/**` — only the `getAuthCapabilities()` touch in step 14.

## 2. AGENTS.md Flag Check

- **Guest-mode persistent write boundary**: applies. The upload flow must
  check whether the user is signed in before calling `apiClient.createProject`;
  guests fall back to `localStorage`. Backend already enforces the gate
  (401 on unauth writes); this is the client-side mirror for UX.
- **CORS widening**: N/A. CORS is scoped to `APP_BASE_URL` already.
- **OAuth provider tokens**: N/A — Better Auth owns these server-side.
- **Data-model assumptions**: N/A. Client consumes the JSON API; Mongo
  shape is irrelevant.
- **New public endpoints / rate limiting**: N/A. Cloudflare rate-limit
  rule already gates `/api/*`.
- **Upload validation**: `uploadPipeline.ts` handles client-side
  sanitization; server re-validates on pass-through.
- **Committed user-scoped data**: N/A — no user data in repo.
- **`packages/core` purity**: applies to step 14. `getAuthCapabilities`
  must stay I/O-free.
- **Hands-off surfaces**: not touched.

## 3. Ambiguity Check

**Ambiguity A — test users / sign-up allowlist UI.** User asked for a
page that adds test users who can sign in during Google's "Testing" consent
mode. Two interpretations:

- Option A: A UI inside the Muralist app that manages an allowlist. This
  doesn't map to anything Google supports — the Test Users list lives in
  the Google Cloud Console, not in our app.
- Option B: Just document the Google Console URL users can go to
  (<https://console.cloud.google.com/apis/credentials/consent>). Done; in
  `docs/OAUTH_PROVIDER_SETUP.md`.

Decision: Option B. There's no product need for an in-app allowlist until
we're in "Published" consent mode anyway. Treat as a dev-console workflow.

**Ambiguity B — handling the Projects view while PrototypeApp is the
upload editor.** The existing `apps/web/app/PrototypeApp.tsx` IS the editor.
Options:

- Option A: `/projects` is the new landing page; clicking a tile routes to
  `/projects/:id` which hosts PrototypeApp with that project loaded.
- Option B: Projects dashboard is a modal/sidebar over PrototypeApp.

Decision: Option A — proper routes. Requires a small refactor of PrototypeApp
to accept an initial project via props (load palette / image on mount from
`apiClient.getProject(id)`). Keep `/` as the guest-mode entry point that
renders PrototypeApp with no pre-loaded project.

**Ambiguity C — session cookie across pages.** Better Auth's cookie is
HttpOnly + Secure + SameSite=Lax, domain-scoped to the API host. When the
web app is on a different domain (e.g. `muralist.example` vs
`api.muralist-api-vbgh6.ondigitalocean.app`), the cookie won't flow.

Decision: this has to be resolved by Cloudflare + a shared parent domain
when that lands (task #16). Until then the UI must be hosted on the same
origin as the API (fine for staging — deploy the Next.js app to the same
App Platform service, different component). Flag explicitly in the PR.

## 4. Verification Approach

Run from repo root after implementation:

- `npm run typecheck`
- `npm run test` (apps/web + apps/api)
- `npm run build`
- `npm run lint`

Manual:

- Unauthenticated: visit `/`, land on PrototypeApp, upload art, get palette.
  Guest flow unchanged.
- Visit `/signin`, click "Sign in with Google". Land on Google's consent.
  Approve. Redirect to `/projects` with an empty dashboard.
- Upload art, click Save. Tile appears in `/projects`. Refresh — it
  persists (from Mongo).
- Save 3 tiles; fourth triggers the one-grace-save path, fifth rejected
  with the OverLimitError inline message.
- Open Settings → Pro Settings → change sensitivity to "Aggressive" →
  refresh the page → setting persists (round-trip through `/me/pro-settings`).
- Open Settings → "Download my data" → JSON blob with projects downloads.
- Open Settings → "Delete account" → confirm → `deletionPendingAt`
  visible. Click "Cancel deletion" → cleared. Verify via
  `curl https://.../me` with the session cookie.
- Hit the Pages preview for this branch once Cloudflare + domain are
  wired; verify the signed-in flow works behind the proxy.

## 5. Open Questions

1. **Custom-domain cutover sequencing** — resolving Ambiguity C cleanly
   requires the UI and API to share a parent domain. When Cloudflare lands
   (task #16), decide whether to host the web app on the same DO App
   Platform service (different component), or a separate service with a
   subdomain.
2. **Avatar handling** — Google returns a profile picture URL. Should the
   web UI show it in the header? If yes, add to `/me` response or use
   Better Auth's user record directly.
3. **Sign-out UX** — redirect destination after sign-out? Default: `/`.
   Worth confirming.
4. **Pro-settings migration** — existing users may have `localStorage` Pro
   Settings from the pre-backend era. First-time authenticated load should
   offer to import those into the server record. Flag for the UI round.
5. **Apple sign-in button rollout** — Apple requires the config-shape
   change in `apps/api/src/auth.ts` (see `docs/OAUTH_PROVIDER_SETUP.md`).
   Until that ships, the Apple button is greyed.
