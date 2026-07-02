# Brand color matching (RGB → orderable named paint color)

**Status: SHELVED — future feature. No development effort for now.**
Decision recorded 2026-07-02. Revisit when prioritized.

## Goal

Given a palette color (RGB/hex) extracted from artwork, tell the user the specific
**orderable** paint color to buy from a chosen brand — color **name + product code**
(e.g. Benjamin Moore "Hale Navy" HC-154) — for Benjamin Moore, Sherwin-Williams,
Valspar, and Behr.

## Decision: buy, don't build (consume a paid aggregator API; do not cache)

Based on a deep-research pass (2026-07-02, adversarially verified). Key findings:

- **No official queryable color API exists for any of the four brands.** The
  "cache an official manufacturer API" path (our first preference) is unavailable.
- Self-hosting local datasets is possible but uneven: Sherwin-Williams publishes a
  clean first-party spreadsheet (name + color number + RGB + hex); Benjamin Moore
  offers official swatch-file downloads (name + hex, product code uncertain);
  **Behr's ToU forbids scraping/redistribution/commercial use** (legal risk); and
  **Valspar has no usable local dataset** — the biggest gap.
- Because the two hardest brands (Behr = legal, Valspar = no data) are *solved* by
  paid aggregators, and the user is willing to pay + not cache, the pragmatic path
  is to **consume a third-party paint-match API directly** rather than build the
  matcher + per-brand data ingestion ourselves.

### Vendor candidates (all cover the four brands; opaque public pricing)

1. **Encycolorpedia** — has a real API (User / Pro / Enterprise tiers, OpenAPI
   spec; https://encycolorpedia.com/api). Covers Valspar (~5,477), Behr (6,723),
   Benjamin Moore, Sherwin-Williams (~1,937). Pricing behind sign-in.
2. **EasyRGB** — sells commercial APIs (ColorD3/ColorQ3/MegaFandeck); data is
   spectrophotometer-sampled (better provenance). Covers all four.
3. **Match My Paint Color** (https://www.matchmypaintcolor.com/) — by name / brand
   id / hex; alternative.

Get quotes from at least Encycolorpedia **and** EasyRGB before committing.

## ⚠️ ACTION BEFORE ANY BUILD — create an account first

Development is blocked on account setup + contract confirmation. When we pick this
up, the FIRST step is:

1. **Create an Encycolorpedia account** (and an EasyRGB account) and read the tier
   pricing on the sign-in page.
2. Confirm three things per tier before choosing: **(a) price**, **(b) commercial
   use permitted in a paid product**, **(c) request quota / rate limit + whether a
   batch endpoint exists**.
3. Obtain API credentials; store as a **server-side secret** (never client-exposed).

**Likely tier: Pro.** The "User" tier reads as personal/hobby (ad-free browsing +
basic API, probably personal-use license); Enterprise is overkill until high
volume. Pick the cheapest tier that grants commercial use and whose quota covers
our volume.

## Feature outline (implement later)

- **UI:** an explicit **"Find orderable colors"** action (per palette, or per
  selected brand) — NOT automatic on upload. Gating the call keeps volume/cost low.
- **Calls:** one **batched** request per lookup (send the whole palette, get all
  matches) if the vendor supports it. Keep an **in-session memory cache** to avoid
  redundant identical lookups — no on-disk/DB caching (respects vendor ToS + the
  no-cache stance).
- **Volume math:** batched ≈ 1 call per lookup (~2k/mo at 1k users × 2 lookups) vs.
  per-color ≈ 30× that — design for batched to stay in a low tier.
- **Adapter:** a thin server-side adapter (in `apps/api`) wrapping the chosen
  vendor, so we can swap vendors or fall back to a local matcher without touching
  the editor. Credentials live server-side; the web app calls our endpoint.
- **Output:** advisory **top 2–3 matches** per color with name + code + Delta-E,
  plus a clear disclaimer.
- **Matching method (if we ever go local instead):** Delta-E **CIEDE2000 in
  CIELAB**, not naive RGB Euclidean — implement in `packages/core` (pure, no deps).
  Our current `flattenImageToPalette` uses RGB Euclidean, which is fine for
  paint-by-numbers preview but wrong for "nearest orderable color."

## Caveats to surface to users

- Published brand hex/RGB are **screen approximations of physical paint** (LRV,
  sheen, substrate, metamerism). Any match is **advisory** — show top matches, not
  one authoritative answer. Even aggregators say a cross-brand match is "that
  brand's version" of the color.

## Legal

Color **names and codes are trademarks**; raw factual RGB values likely aren't
copyrightable (*Feist*), but **ToU contracts** (especially Behr's) restrict use
regardless of copyright. Vendor API responses are governed by the vendor's
commercial terms. **Legal review advisable before shipping** any brand data
commercially — but consuming a licensed paid API (with commercial-use terms
confirmed) is the lowest-risk route.

## Research provenance

Deep-research workflow run 2026-07-02 (101 agents, 19 sources, 25 claims verified).
Primary sources: sherwin-williams.com downloadable palettes, benjaminmoore.com
color-palette downloads, github.com/jpederson/colornerd (unlicensed community
data), behr.com/terms-of-use, easyrgb.com, encycolorpedia.com/api,
markusn/color-diff (CIEDE2000 JS lib), ColorAide docs.
