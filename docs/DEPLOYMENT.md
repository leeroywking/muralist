# Deployment

## CI

GitHub Actions validates the repository on every pull request and push to `main`.

Validation includes:

- `npm install`
- `npm run typecheck`
- `npm run test`
- `npm run build`

The CI workflow also uploads build artifacts so each run produces testable outputs:

- `api-dist`
- `web-static`
- `mobile-export`

## GitHub Pages

The web app is configured as a static export and deploys automatically to GitHub Pages from `main`.

Current deployment assumptions:

- Repository Pages site path: `/muralist`
- Next.js export mode enabled
- `basePath` and `assetPrefix` are applied only in the Pages build

If this repository later moves to a custom domain or a user Pages site, update:

- `GITHUB_PAGES_BASE_PATH` in the workflow
- [next.config.mjs](/home/ein/projects/muralist/apps/web/next.config.mjs)

## AWS Path

The current GitHub Pages deployment is the minimum public delivery path for the prototype. It does not block a future AWS deployment.

The repo is still structured for an AWS move later:

- Web can move to S3 plus CloudFront or a Next-compatible runtime
- API can move to ECS, App Runner, or Lambda
- Mobile artifacts can feed later distribution tooling
- Config and domain logic are isolated from the deployment target
