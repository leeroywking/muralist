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

