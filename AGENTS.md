# AGENTS.md

Operating rules for AI coding assistants working in this repository. Muralist is an npm-workspaces monorepo (`apps/{api,web,mobile}`, `packages/{config,core}`) in an early foundation stage, and it is also the working project for an AI-assisted developer curriculum. Both facts shape the rules below.

## Read before editing

Always read these first:

- `README.md` — product scope, stack, and verification expectations.
- `docs/ARCHITECTURE.md` — service boundaries and the DynamoDB-first data model.
- `docs/SECURITY_REVIEW.md` — guest-mode boundary, CORS posture, known dependency advisories.
- `docs/RETENTION_POLICY.md` — user-facing retention rules: 14-day trash, guaranteed retention, pass-through image handling, account-deletion window, sub-processors.
- `docs/DEPLOYMENT.md` — CI, Pages deploy, mobile prerelease flow.
- `docs/curriculum.md` — curriculum context and the `docs/` vs `worklog.md` convention.
- `worklog.md` — current session context.
- `.agents/skills/` — repo-scoped skills covering common task shapes (planning, debugging, refactoring, reviewing, security review, docs, triage). Prefer using the matching skill over freestyling the same workflow. `docs/prompt-library.md` is the index.

Task-adjacent reads:

- Touching estimation, palette merging, or paint math → read `packages/core` before writing.
- Touching brand coefficients or global defaults → read `packages/config` and `config/paint-brands.yaml`.
- Touching API routes → read `apps/api` entry and the relevant route module before editing.
- Touching auth or session code → read `apps/api/src/auth.ts` (Better Auth config) before editing.
- Touching upload validation → read `apps/api/src/imageValidation.ts`; pass-through only, no image libraries in the request path.
- Touching tier limits or upload caps → read `config/tiers.yaml`, `config/upload-limits.yaml`, and `packages/config`.
- Touching the web export → read `apps/web/next.config.mjs` for `basePath` / `assetPrefix` behavior.

## Scope discipline

- Do exactly what was asked. Do not refactor, rename, or reorganize adjacent code, even if it looks improvable.
- Do not add speculative abstractions, helpers, or "future-proofing" beyond what the task requires.
- Do not fix unrelated lint, typing, or formatting issues in passing. Flag them instead.
- Bug fixes should be the minimum change that fixes the bug.

## Verification before declaring done

Run from the repo root. These are the actual scripts wired in `package.json`:

- `npm run typecheck`
- `npm run test`
- `npm run build`
- `npm run lint`

Notes specific to this repo:

- `typecheck` and `test` already build `@muralist/config` and `@muralist/core` first, so you do not need to pre-build them.
- Workspace-scoped runs use `npm run <script> --workspace @muralist/<name>` (e.g. `@muralist/api`, `@muralist/web`, `@muralist/mobile`, `@muralist/core`, `@muralist/config`).
- If you cannot actually run a command (sandbox, missing deps, UI-only change), say so explicitly rather than claiming success.

## Worklog and curriculum docs are append-only

- `worklog.md` entries are a historical record. Never overwrite or rewrite an existing entry. Add a new entry for new work.
- Existing sections in `docs/*.md` are authoritative. Do not rewrite them to fit a new task — add a new section or a new file.
- Curriculum artifacts belong in `docs/`. Session notes belong in `worklog.md` at the repo root.
- If a prior entry is factually wrong, flag it and propose a correction entry rather than editing history in place.

## Flag before implementing

Stop and raise the concern before writing code if the task would:

- Create or modify any write path without enforcing the guest-mode boundary (`session.kind === "user"` must gate every persistent write).
- Widen CORS, add new public origins, or disable existing origin checks.
- Store OAuth provider tokens in client-accessible storage, or parse provider tokens outside the central auth boundary.
- Commit user-scoped brand data, secrets, or per-user overrides into the repo (user overrides belong in a datastore).
- Introduce relational-join assumptions into domain models or API contracts — the data model is document-shaped on MongoDB (per `docs/ARCHITECTURE.md`'s 2026-04-23 update). No joins across entity aggregates.
- Add a new public endpoint without input validation or rate limiting.
- Bypass upload validation (file type, size, image decoding).

Security context that should inform decisions: `docs/SECURITY_REVIEW.md` records known high-severity advisories in the Expo toolchain and current Fastify line — do not silently upgrade or swap these frameworks as a side effect of another task.

## Do not touch without explicit instruction

- `.github/workflows/**` — CI, Pages deploy, and mobile prerelease pipelines.
- `package.json` scripts at the repo root and in workspaces.
- `tsconfig.base.json` and workspace `tsconfig*.json`.
- `apps/web/next.config.mjs` `basePath` / `assetPrefix` — coupled to the `/muralist` Pages deploy path.
- Dependency versions, especially Expo, React Native, Next.js, and Fastify. Version bumps are their own task.

## Ambiguity policy

If the task is ambiguous, ask one clarifying question. If the user is unavailable or the ambiguity is minor, proceed — and when there are two reasonable interpretations, prefer building both options side by side so the human can compare them in the PR preview rather than defaulting to only the most conservative one. State the assumptions and the options presented in the response.

## Ship it for human review

Feature work on this repo is not done when the code compiles. The point is that a human can see and approve the change running live. Work toward that end state:

- Land changes on a feature branch and open a PR — do not leave work only in the local worktree.
- The Pages deploy publishes both production (from `main`) and per-feature previews, so a feature branch PR produces a reviewable live URL. Reference that preview in the PR description when UI is affected.
- Include a short test plan in the PR body (what to click, what to verify). UI changes should also call out the preview URL and any non-obvious states to check.
- If a change cannot be reviewed live (pure backend, infra-only, config-only), say so explicitly in the PR and describe how a reviewer can verify it.
- Do not mark a task complete with "typecheck and tests pass" alone when the change is user-visible — the live preview is part of done.
- Pushing the branch or opening the PR is not "shipped." CI has to actually finish. Wait for the build and preview deploy to complete, then confirm they succeeded (e.g. `gh pr checks` or the Actions run) before reporting the task done.
- If CI fails, keep working. A failed build produces no testable artifact, so the human cannot review it. Diagnose the failure, push a fix, and wait for the next run. Repeat until the build is green and the preview is live.
- Only hand back to the human once CI is green and, for user-visible changes, the preview URL actually loads the new behavior.

## Repo-specific gotchas

- `packages/core` is pure business logic. No I/O, no network, no filesystem — keep it that way so it stays usable from API, web, and mobile.
- `packages/config` validates global paint-brand defaults at load time. Changes to `config/paint-brands.yaml` must still pass config validation and tests.
- The web app is a static export deployed to GitHub Pages at basePath `/muralist`. Absolute URLs and asset paths must respect this.
- The iOS tester release is a simulator build today. Do not assume TestFlight or signed-device distribution is wired up.
- `npm audit` advisories in Expo and Fastify are known and tracked; do not treat them as new findings.
