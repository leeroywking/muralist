# Muralist Roadmap

## Purpose

Build a website plus iOS and Android apps with the same core workflow:

1. A muralist uploads an image in a common format.
2. The system analyzes the image.
3. The system returns a short, practical paint color list suitable for estimating materials.
4. The system applies configurable paint-brand coverage assumptions to support rough planning.

This document is written to be agent-compatible: each phase is broken into concrete deliverables, constraints, and acceptance criteria.

## Product Direction

### Primary user

A muralist planning a project who needs a fast estimate of which paint colors they will likely need, without being overwhelmed by minor shading variations.

### Core v1 outcome

Given an uploaded artwork image, produce:

- A reduced color list, typically under 20 colors
- A swatch preview for each final color
- A pixel coverage percentage per final color
- A paint-brand-aware estimation baseline using configurable coverage coefficients
- A clear indication that near-identical shades were merged intentionally

### Important domain rule

The app should not treat every shaded pixel as a separate paint color. It should intelligently merge visually similar colors because muralists often create shading manually from a practical palette.

## v1 Functional Scope

### Must have

- Upload images from device storage
- Support common formats: `jpg`, `jpeg`, `png`, `webp`, `heic` if platform support allows
- Validate file type and file size
- Extract a representative set of image colors
- Merge similar colors into a short practical palette
- Let the user adjust palette size target within a safe range
- Show final colors as swatches with hex values
- Show approximate image coverage percentage for each final color
- Include a configurable paint organization system for major brands
- Use brand-specific rough coverage coefficients in estimation logic
- Persist recent analyses per user device/account

### Should have

- Optional manual merge and split controls after auto-analysis
- Export color list as PDF or CSV
- Save project name, wall dimensions, and notes for later estimation work
- User-scoped brand preferences and custom coefficient overrides

### Explicitly out of scope for the first round

- Commercial-grade paint brand matching
- Highly accurate gallon or liter purchasing recommendations
- Multi-image project boards
- Collaboration features
- Desktop-native apps

The first round can include rough coefficient-backed estimate inputs, but not a polished purchasing engine.

## Cross-Platform Product Strategy

### Recommended approach

Use a shared backend and a shared mobile codebase where possible.

- Web: Next.js
- Mobile: React Native with Expo
- Backend/API: TypeScript service
- Storage: cloud object storage for uploaded images
- Database: relational database for projects, analyses, and settings
- Deployment target: one easily deployable fullstack stack with managed services where possible

This gives the website and iOS/Android apps the same business logic and API while keeping UI implementation efficient.

### Shared logic target

The color-analysis and color-merging rules should live in one backend service, not separately in web and mobile clients. That avoids inconsistent results across platforms.

The paint coefficient catalog should also be backend-owned so all clients use the same estimation assumptions.

## Technical Architecture

### Client apps

- Web app for uploads, history, and review
- Mobile app for the same workflow with camera-roll upload support
- Shared design system tokens so web and mobile feel like one product

### Backend services

- Auth service or managed auth provider
- Upload service for image ingestion
- Analysis service for palette extraction and color reduction
- Project service for saving and retrieving past results
- Paint catalog service for brand coefficient lookup and future user-scoped overrides

### Data model, initial

- User
- Project
- UploadedImage
- AnalysisResult
- ReducedColor
- PaintBrandProfile
- UserPaintBrandPreference

### Config model for paint brands

For the first round, brand assumptions should live in a configurable file such as JSON or YAML and be loaded by the backend at startup.

Required fields:

- Brand identifier
- Display name
- Retailer
- Coverage coefficient range in square feet per gallon
- Default coefficient used by estimation logic
- Optional coat multiplier defaults
- Notes and source URLs

Future state:

- Global defaults ship with the app
- Users can override or extend them in account-scoped settings

## Core Analysis Logic

### Problem

Artwork often contains many technically distinct colors that are not practically distinct paint choices.

### Proposed v1 pipeline

1. Normalize image input.
2. Resize for analysis while preserving enough fidelity.
3. Convert colors into a perceptual color space such as `Lab` or `LCh`.
4. Extract candidate colors with clustering.
5. Merge colors that are perceptually close.
6. Enforce a max palette target, defaulting below 20.
7. Compute final coverage percentages from merged assignments.
8. Feed palette coverage data into rough paint estimation inputs using brand coefficients.

### Practical merging rules

- Use perceptual distance, not raw RGB distance
- Bias toward merging colors with small hue differences and moderate lightness differences
- Be more aggressive merging low-coverage edge cases
- Preserve genuinely distinct high-coverage colors
- Allow target palette presets such as `8`, `12`, `16`, `20`

### Candidate algorithms to evaluate

- K-means in `Lab`
- Median cut or modified median cut
- Hierarchical clustering on top of extracted candidates
- Post-processing merge pass using Delta E thresholds

### Recommended starting implementation

Begin with:

- Image preprocessing
- Initial clustering in `Lab`
- A post-cluster merge pass using Delta E thresholds
- Coverage-based cleanup for tiny clusters

This is simpler to ship quickly than a highly custom quantization pipeline and should be good enough for v1 validation.

## Paint Brand Coefficients

### Goal

Seed the estimation system with rough but configurable coverage assumptions for major consumer paint brands commonly used by muralists.

### Initial brand set

- Sherwin-Williams
- Valspar at Lowe's
- Behr at Home Depot

### v1 implementation rule

These coefficients are approximation inputs only. They should be stored in a config file and treated as editable defaults, not hardcoded truth.

### Initial approximation guidance

- Sherwin-Williams: assume roughly `350-400` square feet per gallon, default `375`
- Valspar at Lowe's: assume roughly `400-450` square feet per gallon, default `425`
- Behr at Home Depot: assume roughly `250-400` square feet per gallon, default `325`

### Estimation usage

The first prototype should allow the user to select a brand profile and apply its coefficient defaults to downstream paint estimation logic. Exact purchase-grade recommendation quality is not required in this phase.

## UX Requirements

### Upload flow

- Clear supported file types
- Fast validation errors
- Upload progress state
- Analysis-in-progress state

### Results screen

- Original image preview
- Final reduced palette swatches
- Hex code and coverage percentage per swatch
- Visible note that similar shades may have been merged for practical paint planning
- Control to re-run with a different palette target
- Brand selection area for rough coefficient-based estimation assumptions

### Project persistence

- Save analysis with project name
- Reopen previous analyses
- Duplicate a project to try alternate palette settings

## Delivery Phases

## Phase 0: Foundation

### Goals

- Align on product scope
- Choose stack
- Establish repo structure
- Define API boundaries

### Deliverables

- Monorepo initialized
- Shared roadmap and architecture docs
- Professional root README and developer setup docs
- Web app scaffold
- Mobile app scaffold
- Backend scaffold
- CI baseline
- Deployment target defined for web, API, database, and storage
- Brand coefficient config format defined

### Acceptance criteria

- Local development runs for web, mobile, and backend
- One documented command path for bootstrapping the repo
- Environments are separated for dev and production
- A new engineer can understand the project from the README alone

## Phase 1: Upload and Analysis Prototype

### Goals

- Prove the end-to-end workflow
- Validate the color reduction approach

### Deliverables

- Image upload endpoint
- Temporary storage of uploaded images
- Analysis pipeline v1
- Web interface to upload and view results
- Sample dataset of mural-style images for testing
- Initial paint-brand coefficient config and lookup path
- Unit tests for color reduction and coefficient loading
- Integration tests for upload-to-result flow

### Acceptance criteria

- User can upload a supported image and receive a reduced palette
- Default output is usually 20 colors or fewer
- Near-identical shades are merged in a way that feels practical on test images
- Processing time is acceptable for typical uploads
- Brand coefficients can be changed in config without code changes
- Test suite runs in CI

## Phase 2: Shared Product Experience

### Goals

- Bring feature parity to mobile
- Stabilize backend contracts

### Deliverables

- Mobile upload flow
- Shared API contracts
- Saved projects
- Result history
- Basic auth
- User-scoped paint brand preferences

### Acceptance criteria

- Same image returns materially equivalent results on web and mobile
- Logged-in user can access saved analyses across devices
- Error states are clear and recoverable

## Phase 3: Palette Controls and Export

### Goals

- Give muralists better control over practical outputs

### Deliverables

- Palette size selector
- Manual merge and split adjustments
- Export to PDF or CSV
- Project notes and dimensions
- Brand-specific estimate tuning controls

### Acceptance criteria

- Users can refine output without rerunning the full workflow from scratch
- Exported data is usable for planning paint purchases

## Phase 4: Estimation Expansion

### Goals

- Extend from color extraction into material estimation

### Deliverables

- Wall dimensions input
- Coverage assumptions
- Paint quantity estimate by color
- Waste or overage adjustment

### Acceptance criteria

- User can go from artwork to approximate paint quantities using explicit assumptions

## Agent Task Backlog

### Track A: Product and UX

- Define upload flow wireframes
- Define results screen wireframes
- Define saved-projects workflow
- Write copy for merging explanation and empty states

### Track B: Platform and Infra

- Initialize monorepo
- Set up package management and workspace structure
- Add CI
- Configure cloud storage
- Configure database and migrations
- Define deployment path for live demo hosting

### Track C: Analysis Engine

- Choose image processing library
- Implement resize and normalization
- Implement clustering in perceptual color space
- Implement similarity merge pass
- Benchmark against sample images
- Tune thresholds for practical mural use
- Integrate brand coefficient inputs into estimation math

### Track D: API

- Define upload endpoint
- Define analysis job and result schema
- Define project persistence endpoints
- Add auth and authorization rules
- Define paint brand profile endpoints and config loading

### Track E: Frontend and Mobile

- Build upload UI
- Build results UI
- Build saved-projects UI
- Integrate API
- Add retry and error handling
- Add brand selection and estimate assumptions display

### Track F: Quality and Release

- Add unit tests
- Add integration tests
- Add linting and formatting checks
- Ensure production builds pass for web, mobile, and backend
- Publish a live demo tied to the repository
- Document release and deployment steps in the README

## Open Decisions

- Whether to use fully synchronous analysis for v1 or background jobs
- Whether anonymous usage should be allowed before auth
- Which cloud provider to target first
- Whether to store original images long-term or expire them
- Whether `heic` support is required in v1 or can be deferred

## Risks

- Over-separating shades will make results unusable for real mural workflows
- Over-merging colors will erase meaningful design intent
- Large uploads may create slow analysis times on mobile networks
- Different image decoders across platforms may introduce minor result differences if analysis happens client-side
- Rough brand coefficients may create misleading estimates if presented with too much certainty

## Recommended Immediate Next Steps

1. Approve this roadmap as the initial planning document.
2. Initialize a monorepo for web, mobile, and backend.
3. Define the brand coefficient config file and loader.
4. Build the analysis pipeline as a backend prototype before polishing UI.
5. Assemble a small test set of real mural artwork to tune merging thresholds.

## Stop Condition For This Round

This round is complete when there is a working prototype with all of the following:

- Fullstack web plus iOS and Android app structure in place
- Shared backend analysis flow running end-to-end
- Configurable paint brand coefficients wired into estimation inputs
- Unit and integration tests implemented and passing
- CI running builds and tests
- Professional project documentation, including a strong README
- A live demo deployed and referenced from the repository

This round is not complete at the planning stage alone. The expectation is a functioning prototype with engineering discipline visible in code quality, testing, build automation, and deployment.

## Working Agreement

This file is the shared planning source for the project until implementation docs become necessary. Update it when scope, architecture, or delivery sequencing changes.
