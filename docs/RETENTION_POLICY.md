# Retention Policy

This document describes how Muralist retains, recovers, and disposes of user data.
It is the public-facing source of truth for data lifecycle questions.

## Stored per project

- **Palette JSON** — palette colors, classifications, mix recipes, finish and coats
  overrides, Pro Settings snapshot, project metadata. Includes the pre-merge color
  list and the user's merge operations so merges can be reversed by the user.
- **Sanitized reduced image** — the user's source image, downsampled and re-encoded
  client-side before upload. Original resolution and EXIF metadata are discarded in
  the browser.
- **Thumbnail** — a further-reduced image used for the dashboard tile.

The server never stores the original-resolution source image and never stores EXIF
metadata. The sanitization pipeline runs entirely in the browser.

## Retention guarantees

- **Retention is guaranteed for all tiers.** No project is automatically deleted on
  an age-based schedule. Projects persist until the account holder deletes them
  or deletes their account.
- Going over the free-tier project limit (3 active projects) places the account in
  **read-only mode** but does **not** delete any projects. All projects remain
  accessible for viewing, exporting, and deleting; mutation is re-enabled when the
  account falls back under the limit or upgrades to paid.

## User-initiated deletion (trash)

Deleting a project moves it to **trash**. Trashed projects:

- Remain fully recoverable for **14 days** from the moment of deletion.
- Can be restored via `POST /api/projects/:id/restore` during the window.
- Are purged — palette JSON, sanitized image, thumbnail, all metadata — at the end
  of the window. Purge is permanent.

After the 14-day window, a trashed project is unrecoverable.

## Account deletion

Requesting account deletion via `DELETE /api/account`:

- Starts a **30-day in-app confirmation window**.
- During the window the account remains accessible; the user can cancel via
  `POST /api/account/delete-cancel` to undo the pending deletion.
- After the window elapses, the next authenticated interaction triggers a
  complete purge — every project, every thumbnail, every active session,
  and the user record itself.

No emailed confirmation is required or sent (the product does not send transactional
email; the Settings view surfaces the pending-deletion countdown).

## Data export

`GET /api/export` returns a single JSON document containing all the user's
projects — palettes, metadata, and base64-encoded image and thumbnail bytes.
Export is available at any time during the account's active life and remains
available during the 30-day account-deletion window.

## Server-side image handling

Uploaded image bytes pass through the server **without being decoded by an image
library**. The server validates content-type headers, magic-byte signatures
(JPEG `FF D8 FF`, WebP `RIFF....WEBP`), base64 integrity, and size caps, then
writes the bytes directly to MongoDB. No Sharp, libvips, or ImageMagick in the
request path. This is a deliberate pattern aimed at eliminating image-parser CVEs
as an attack surface on the server; the browser's canvas re-encode handles the
sanitization work on the client side before the bytes ever leave the user's device.

## Sub-processors

- **DigitalOcean** — application hosting (App Platform) and database hosting
  (Managed MongoDB).
- **Cloudflare** — edge DNS, CDN, and rate limiting.
- **OAuth identity providers** — Google, Apple, Facebook, Adobe. Each holds the
  user's identity at their end; Muralist receives a provider-issued token and stores
  a session record, not the provider's underlying credentials.

## Change history

- 2026-04-23 — Initial policy published alongside the persistence + auth backend.
