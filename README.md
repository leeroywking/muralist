# Muralist

Muralist is a fullstack web and mobile product for muralists who need a practical paint-planning workflow from artwork. Users upload an image, receive a reduced color palette designed to collapse unnecessary shade variations, and apply configurable paint-brand coverage assumptions to support rough estimation.

## Current State

This repository is in the planning and foundation stage. The current stopping point for the first round is not just a document set. It is a working prototype with:

- A web app
- iOS and Android app support
- A shared backend for image analysis
- Configurable paint brand coefficient data
- Unit and integration tests
- CI running builds and tests
- Professional documentation
- A live demo referenced in the repository

## Product Goals

- Reduce artwork into a short practical palette, usually under 20 colors
- Merge visually similar shades so muralists are not penalized by digital shading noise
- Provide rough brand-aware estimation inputs using configurable coverage coefficients
- Keep results consistent across web, iOS, and Android by centralizing analysis in the backend

## Planned Stack

- Web: Next.js
- Mobile: React Native with Expo
- Backend: TypeScript API service
- Storage: managed object storage for image uploads
- Database: managed relational database
- CI: automated lint, test, and build validation

## Paint Brand Coefficients

Initial planning assumes a configurable catalog stored in YAML or JSON and loaded by the backend. This is intended to become user-scoped later. The first default set covers:

- Sherwin-Williams
- Valspar at Lowe's
- Behr at Home Depot

These coefficients are rough defaults, not hardcoded truth. They should remain editable without code changes.

## Documentation

- Product and delivery roadmap: [ROADMAP.md](/home/ein/projects/muralist/ROADMAP.md)
- Brand coefficient seed config: [config/paint-brands.yaml](/home/ein/projects/muralist/config/paint-brands.yaml)

## Development Standard For Round One

The first round should end with a professional prototype, not a loose experiment. That means:

- Clean repository structure
- Clear setup and deployment docs
- Reviewable commits
- Passing unit and integration tests
- Running production builds
- A live deployed demo

## Notes

Brand coverage assumptions should be sourced from official calculators, technical data sheets, or product coverage guidance where available, then normalized into a configurable backend-owned format.
