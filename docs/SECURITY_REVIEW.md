# Security Review

## Scope

This review covers the current foundation state of the repository on April 7, 2026, including planned auth posture, configuration handling, and the initial API surface.

## Findings

### High

- Dependency audit still reports high-severity issues in the current foundation dependency tree.
  Impact: the remaining advisories are in the Expo mobile toolchain and the current Fastify line, so the repository is not yet in a release-ready dependency state.
  Mitigation: upgrade Expo to a fixed major line, then reassess React Native compatibility; move Fastify to a patched release or replace the API framework if Node compatibility becomes a blocker.

### Medium

- Guest mode creates a product risk if any future endpoint accidentally allows persistence without checking session type.
  Mitigation: every write path should enforce `session.kind === "user"` before accepting saved projects, personal libraries, or account preferences.

- OAuth-only sign-in increases dependence on external providers and token validation correctness.
  Mitigation: centralize provider token verification behind one auth boundary and prefer managed federation rather than bespoke token parsing in each service.

### Low

- Paint brand source data is currently static and repository-owned.
  Mitigation: treat it as non-secret config and keep all user-scoped brand overrides in a datastore rather than in committed files.

- CORS is permissive in the prototype API.
  Mitigation: restrict allowed origins by environment before any public deployment.

## Required Controls

- Enforce authenticated writes for all persistent resources
- Separate guest session state from user session state
- Validate uploaded file type, file size, and image decoding paths
- Scan uploads before long-term retention if public ingestion is enabled
- Avoid storing OAuth provider tokens in client-accessible storage
- Use signed object storage access patterns for uploads and downloads
- Rate-limit upload and estimation endpoints
- Log auth failures and suspicious upload behavior
- Keep secrets in environment or secret-manager storage only
- Run dependency audit in release review even if CI does not hard-fail on it yet

## Review Task Backlog

- Add threat model for image upload abuse
- Add auth middleware tests for guest restrictions
- Add request validation on all API input paths
- Add rate limiting before public prototype release
- Add dependency audit to CI once the current Expo and API advisories are resolved

## Verification Performed

- Reviewed auth posture for guest-mode persistence boundaries
- Reviewed CORS posture in the prototype API
- Ran `npm audit --omit=dev`
- Reduced web-framework risk by moving the web app from a vulnerable Next.js line to `15.5.14`
- Verified the repository still passes typecheck, tests, and builds after the foundation changes

## Current Verdict

The foundation is acceptable to continue development, provided the guest-mode persistence boundary remains explicit and enforced in every future write endpoint.

## 2026-11-19 Update — Expo SDK 58 upgrade

- **Change:** `apps/mobile` moved from Expo SDK 52 / React Native 0.76 / React 18 to Expo SDK 58 / React Native 0.88.1 / React 19.3. `apps/web` moved to React 19.3 as well, so the workspace has a single React version (Next stays on 15.5.14). CI moved to Node 22, which SDK 58 requires.
- **Why now:** the iOS simulator build had failed on every main push since 2026-10-13. GitHub's `macos-latest` runner moved to Xcode 26, and RN 0.76's bundled `fmt` pod does not compile under it.
- **Effect on the High finding above:** `npm audit` went from 46 advisories (28 high/critical) to 20 (14 high/critical). The `@expo/cli`, `@xmldom/xmldom`, `tar`, `cacache`, `ws`, `image-size`, `node-forge` (partly) and `compression` entries from the Expo 52 tree are gone. Still present via Expo's CLI/build tooling, build-time only and not shipped in the app: `node-forge`, `shell-quote`, `browserslist`. The Fastify-line advisories are unchanged and still tracked separately.
- **Known deviation:** Expo SDK 58 recommends TypeScript ~6.0. The repo stays on 5.9 (`expo.install.exclude` in `apps/mobile/package.json`) because a TS 6 move is repo-wide and touches `tsconfig` files. Mobile typechecks clean on 5.9.
