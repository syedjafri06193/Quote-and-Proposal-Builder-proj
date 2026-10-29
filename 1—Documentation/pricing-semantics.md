# Pricing semantics

**Status:** v1 as implemented in rule set v1 — **awaiting finance sign-off.**
These are business decisions with permanent consequences (design guide §3, milestone M0).
Changing any of them later changes historical numbers, so every change is a new
rule-set version that goes through simulation and approval.

| Sign-off | Name | Date |
|---|---|---|
| Finance | | |
| Deal desk / pricing owner | | |

## 1. Money

- All amounts are integer minor units (`bigint`), never floating point.
- **Totals** use the currency's ISO 4217 minor units (USD: 2). **Unit prices and
  in-flight pipeline amounts** use scale 6 (e.g. `$0.0012` per API call).
- Rates are **basis points** (15% = 1500).
- Single currency (USD) in v1; the currency travels with every amount anyway.

## 2. Discount stacking — **multiplicative**

Each percentage discount applies to what remains after the previous one:
20% then 15% = 32% total, not 35%.

- Order of application: rule `priority` ascending, ties broken by rule `id`.
- The rep's manual discount is applied at priority **40** (after partner, term and promo rules).
- **Non-stackable** rules: taken only if no other rule has been selected, and block all later rules.
- **Exclusive groups** (`promo`): only the first rule in the group (by priority, id) applies.
- **Incompatible pairs:** `nonprofit-price` never combines with `multi-year`.
- **Stacking ceiling:** combined line discounts never exceed **50%** of the post-tier amount.
- The rule set can switch to **additive** (each percentage measured against the post-tier
  amount). That is a rule-set change, simulated and approved like any other.

## 3. Rounding — **half-up, once, at the line**

- Mode: **half-up** (ties toward +∞; all quote amounts are positive, so equivalent to half-away-from-zero).
- Rounding point: **each line's extended amount**, to cents. Everything before that
  runs at scale 6, so `$10.005 × 1,000` prices as **$10,005.00**, not $10,010.00.
- Sub-micro-unit results inside the pipeline (e.g. `× 7/12`) round at scale 6 with the same mode.
- Floors round with **ceiling**, so a floor never rounds in the customer's favour.
- Order-level discounts are computed on the rounded subtotal and allocated back to lines by
  largest remainder, so lines always sum exactly to the total.

## 4. Tier models — explicit per product

| Product | Model | Bands |
|---|---|---|
| Platform License | **graduated** (brackets; monotonic) | 1–99 $240 · 100–249 $216 · 250–499 $192 · 500+ $168 (per seat per year) |
| API Calls | **volume** (land-in-tier; creates cliffs) | 1+ $0.0012 · 1M+ $0.0010 · 10M+ $0.0008 (per call per year) |
| Training Day | volume | 1+ $1,800 · 5+ $1,500 |

**Intentional cliffs** (in the test allowlist, `EXPECTED_CLIFFS`): API at 1,000,000 and
10,000,000 calls. Any other cliff fails the build.

## 5. Floors — **clamp and warn**

- Default maximum discount vs list: **40%**. Platform License: **45%**.
- Minimum prices: Onboarding $2,500; API $0.0006 per call.
- When a discount would breach a floor, the line is **clamped** to the floor, a warning is
  shown on the quote and in the price trace, and the `floor-clamped` approval rule routes the
  quote to deal desk.
- Order-level discounts never push a line below its floor; any excess is dropped with a warning.

## 6. Term and proration

- Recurring prices are **per unit per year**. A term of *N* months prices as **N/12 of annual**
  (a 14-month term is 14/12 × annual, not annual + 2 months).
- Day-count convention: **whole months.**
- Term starts on the quote's **start date** (not the signature date). The term end is the day
  before start + N months (12 months from 2026-11-01 ends 2027-10-31).
- One-time items are recognised point-in-time on the start date.

## 7. Tax

Never computed here. Quote totals exclude tax; tax is delegated to the tax provider
(Avalara / Stripe Tax) at invoicing.
