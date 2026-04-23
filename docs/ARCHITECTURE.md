# Architecture

## Foundation Decisions

- Runtime and tooling: Node.js with `npm` workspaces
- Web app: Next.js
- Mobile app: Expo React Native
- API: Fastify with TypeScript
- Auth: OAuth-only for persistent users, plus guest mode with no data persistence
- Data model: DynamoDB-first design
- Deployment target: AWS, but with service boundaries that avoid locking development to AWS-specific code too early

## Auth Model

Persistent user data requires sign-in via federated identity providers:

- Google
- Apple
- Facebook
- Additional common providers can be added later through the same auth boundary

Guest mode is explicitly allowed, but with strict limitations:

- No saved projects
- No personal paint library
- No account-linked history
- No cross-device persistence

This keeps the product accessible for trial use while preventing hidden persistence for unauthenticated sessions.

## AWS Readiness

The prototype should stay easy to map onto AWS services later:

- Web app can be deployed behind CloudFront or adapted for OpenNext-style deployment
- API can map to ECS, App Runner, or Lambda behind API Gateway
- Uploaded images can map to S3
- OAuth federation can map to Cognito or another brokered identity layer
- Non-relational application data can map to DynamoDB

## DynamoDB-First Data Model

Recommended top-level entities:

- `USER`
- `PROJECT`
- `ANALYSIS`
- `BRAND_PREF`

Recommended access patterns:

- Fetch user profile by auth subject
- List projects by user
- Load project and latest analysis
- Save or update user paint-brand preferences
- Read global paint-brand defaults

Suggested single-table patterns can come later. At the foundation stage, the important point is that the API contracts and domain models should not assume relational joins.

## Service Boundaries

- `packages/config`
  Loads and validates global paint-brand defaults.
- `packages/core`
  Holds pure business logic such as auth capability rules and estimation math.
- `apps/api`
  Exposes HTTP endpoints for auth capabilities, paint-brand catalog data, and rough estimation.
- `apps/web`
  Hosts the browser-facing product shell.
- `apps/mobile`
  Hosts the mobile product shell.

## Why NoSQL Is Reasonable Here

This product has several characteristics that fit a document or key-value model well:

- Project records are naturally aggregate-shaped
- User preferences are sparse and flexible
- Analysis results can be stored as nested documents
- Early product iteration benefits from schema flexibility

There is no compelling reason at this stage to force a relational model. If later reporting or analytics requirements become join-heavy, a second datastore can be introduced for that concern without rewriting the product boundary.

## 2026-04-23 Update — Current Implementation

The scoping round captured in `docs/plans/persistence-and-auth-backend.md` settled on a different cloud target and data store than the "AWS Readiness" and "DynamoDB-First Data Model" sections above describe. Those sections remain as the earlier foundation decisions; the current implementation supersedes them as follows.

### Current cloud target

DigitalOcean App Platform (API host) + DigitalOcean Managed MongoDB (data layer) + Cloudflare Free (edge layer: DNS, CDN, DDoS, rate limiting). AWS and Oracle Cloud are explicitly ruled out for this product due to metered-billing spiral risk. All chosen services are flat-rate / pay-in-advance so monthly cost is predictable.

### Current data model

Document-shaped aggregates on MongoDB. The "no relational joins across entity aggregates" spirit of the earlier DynamoDB-First framing carries over — design aggregates one-user-at-a-time, not via joins across entities.

Collections:

- `users` — one document per user. Carries `sub`, linked providers, `tier`, `subscriptionStatus`, `atLimit`, `overLimit`, `activeProjectCount`, `proSettings`, `createdAt`, `lastSignInAt`, optional `deletionPendingAt`.
- `projects` — one document per project. Holds `name`, palette JSON (with reversible merge operations), sanitized reduced image (`BinData`), metadata, version, status, `createdAt`, `updatedAt`, `lastViewedAt`, optional `deletedAt`.
- `project_thumbnails` — one document per project, keyed by `projectId`. Thumbnail (`BinData`), name, `lastViewedAt`, status. Dashboard lists read only from this collection, never touching the heavier `projects` documents.
- `sessions` — Better Auth–managed, powers the Recent sign-ins / active devices list.

### Auth layer

Better Auth, self-hosted in-process with the Fastify API. Sessions stored in the `sessions` collection. Providers: Google, Apple, Facebook (built-in) plus Adobe via the Generic OAuth plugin pointed at Adobe IMS. HttpOnly cookie + CSRF token for web session mechanics.

### Service boundaries (updated)

- `packages/config`
  Loads and validates global paint-brand defaults, tier limits, and upload sanitization limits.
- `packages/core`
  Holds pure business logic such as auth capability rules and estimation math.
- `apps/api`
  Exposes HTTP endpoints for auth (Better Auth), project CRUD, `/me`, export, account deletion, paint-brand catalog data, and rough estimation.
- `apps/web`
  Hosts the browser-facing product shell. Also owns the client-side image sanitization pipeline (`apps/web/app/uploadPipeline.ts`).
- `apps/mobile`
  Expected to be a ground-up mobile build in a later round; out of scope for the backend.

### Image handling posture

The app server never decodes uploaded image bytes. No Sharp, libvips, or ImageMagick in the request path. Inbound images are validated at the boundary (content-type, magic bytes, base64 integrity, size cap) and passed through to MongoDB as BinData. The browser canvas re-encode is the primary defense against malformed/polyglot files; the server's checks are cheap, parser-free corroboration. See `docs/RETENTION_POLICY.md` for the user-facing phrasing and `docs/plans/persistence-and-auth-backend.md` §2.1 for the rationale.
