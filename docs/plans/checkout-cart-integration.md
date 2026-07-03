# "Checkout" — programmatic cart / retailer handoff

**Status: research complete (2026-07-02). Feature NOT built.** Recommended shape is a
deep-link "shop these colors" panel, NOT a one-click filled cart. Future work.

## Goal (as asked)

From a finished palette, a "Checkout" button that sends the customer to the
retailer (Sherwin-Williams / Behr / Valspar / Benjamin Moore) with their required
paints (color + finish + size + quantity) already in the cart.

## Core finding: a pre-filled cart is largely NOT achievable — structural, not technical

Mural paint is **mixed-to-order** (tinted from a base at the counter). Therefore:
- It is **final-sale, non-returnable, and has no stocked SKU**; the color is realized
  at the in-store tinting station, not selected as a product variant.
- There is nothing to encode a specific color into a cart link/API with. The ceiling
  for all four brands is a **deep link to the color's product page**, where
  size/sheen are chosen and the tint code is entered/spoken at purchase.

## Per-retailer verdict

| Brand → Retailer | Verdict | Why |
|---|---|---|
| Sherwin-Williams (direct) | **Product-page deep link only** | Real first-party cart, tinted paint orderable online (delivery + BOPIS), but cart is JS-driven (no `?add-to-cart=` pattern) and pricing/checkout are gated behind a **PaintPerks login** → no shareable link survives logged-out. Runs on IBM WebSphere Commerce. |
| Benjamin Moore (dealers) | **Partial / BOPIS-only** | Central cart at `store.benjaminmoore.com`, but pickup-only via independent dealers, color realized in-store, **no ship-to-home for tinted**, no public cart-permalink API. Some large dealers (e.g. Ricciardi Bros) run **Shopify** → inherit `/cart/{variant}:{qty}` permalinks, but color is a **free-text field**, not URL-encodable. Dealer-by-dealer. |
| Behr → Home Depot | **Product-page deep link only** | No native add-to-cart URL or public cart API surfaced (absence-of-evidence). |
| Valspar → Lowe's | **Product-page deep link only** | Same. |

Not viable: **Share-A-Cart** is a browser extension both parties must install (not a
link/API); **Rye "Universal Checkout API"** was adversarially **refuted** — do not
architect around universal-cart services.

## Revenue path (the one strong positive)

**Benjamin Moore affiliate program via Awin pays 6% on all verified online orders**
(benjaminmoore.com/en-us/affiliate-marketing-program; Awin merchant #95853). A BM
"checkout" button can be a **monetized Awin deep link** — commission on BOPIS orders
with no cart API needed. Home Depot / Lowe's affiliate programs (Impact/CJ) are
plausible but unverified. Ties to [[project_monetization_principle]].

## Recommended feature shape (when built)

A **"Shop these colors at <retailer>"** panel, not a filled cart:
- One **deep link per color** to that brand's product page.
- Our UI shows the **shopping list** (color name + code + finish + size + quantity)
  since that can't ride in the link — the user hands the codes to the store / tint
  station.
- **Benjamin Moore link = Awin affiliate deep link** (monetized).
- Honest framing to the user: "here's what to buy and where," not "one click and it's
  in your cart."

## Open follow-ups (before/if building)

1. **Dedicated Home Depot (Behr) + Lowe's (Valspar) pass** on their product/partner
   APIs and affiliate (Impact/CJ) deep-linking — the "no cart API" for these two is
   absence-of-evidence, not proven; highest-value next research if pushing feasibility.
2. Confirm retailer **ToS / bot-automation / deep-link-into-checkout** clauses — not
   verified; legal glance before shipping.
3. For BM: can the Awin deep link + a pre-selected product/store approximate a
   "pre-filled checkout," and what's national dealer coverage for online ordering?

## Provenance

Deep-research workflow, 2026-07-02 (103 agents, 21 sources, 25 claims verified, 18
confirmed / 7 killed). Key sources: sherwin-williams.com (how-to-buy-online, terms
§8 tinted non-returnable), store.benjaminmoore.com + benjaminmoore.com
(pickup-in-store, affiliate-marketing-program), ricciardibrothers.com (Shopify BM
dealer), share-a-cart.com, rye.com (refuted).
