# Rule authoring guide (deal desk)

Pricing rules are **data**, owned by deal desk / finance, changed without a deploy — but
every change goes through the same lifecycle:

```
DRAFT ──▶ SIMULATED ──▶ PENDING_APPROVAL ──▶ PUBLISHED (immutable, new version)
```

1. **Create a draft** (Rules & governance → New draft). It starts as a copy of the rule set in force.
   Only `pricing-analyst` and `pricing-owner` roles can author.
2. **Edit** the JSON definition. The page validates on every save: unknown fields, wrong types,
   bad basis points and unknown approver roles are errors; anything questionable is a warning.
3. **Simulate.** Mandatory. The draft re-prices the most recent 200 quotes and reports the revenue
   delta and how many quotes would newly need more approval. Any edit after simulation invalidates it.
4. **Submit** to the pricing owner.
5. **Approve & publish** — a `pricing-owner` who is **not the author**. The result is a new,
   immutable rule-set version. Existing quotes keep the version they were priced under; they only
   change if someone explicitly reprices them.

**Effective dating:** leave "Effective from" as `on-publish`, or give a future ISO timestamp
(e.g. `2027-01-01T08:00:00Z` for the new quarter). Retroactive dates are refused.

## Conditions

Rules use a small expression language over a fixed set of fields — never code.

```json
{ "op": "and", "terms": [
  { "op": "eq",       "field": "quote.channel",    "value": "partner-gold" },
  { "op": "gte",      "field": "quote.termMonths", "value": 36 },
  { "op": "contains", "field": "quote.promoCodes", "value": "Q4-2026" },
  { "op": "in",       "field": "line.productId",   "values": ["plat", "sso"] },
  { "op": "not", "term": { "op": "eq", "field": "line.chargeType", "value": "one-time" } }
]}
```

Operators: `eq neq gt gte lt lte in contains and or not true`.

| Scope | Fields | Used by |
|---|---|---|
| `line.*` | `productId sku family chargeType quantity termMonths` | discount rules |
| `quote.*` | `accountId segment channel promoCodes asOf termMonths quoteType paymentNetDays` (+ `subtotal` for order rules) | discount & order rules |
| `approval.*` | `total totalDiscountBp maxLineDiscountBp maxManualDiscountBp floorClamped nonStandard paymentNetDays termMonths legalTermsVersion segment` | approval rules |

Money values are decimal strings (`"250000"`); dates are `YYYY-MM-DD`; discounts are basis points.

## Discount rules

```json
{
  "id": "partner-gold", "name": "Gold partner discount",
  "priority": 20, "stackable": true, "stackGroup": "promo (optional)",
  "condition": { … },
  "effect": { "type": "percent", "basisPoints": 1000 }
}
```

Effects: `percent` (basis points), `amount` (`perUnit` off, per year for recurring),
`overridePrice` (`perUnit` price). See `docs/pricing-semantics.md` for stacking order.

## Approval rules

```json
{
  "id": "discount-vp", "name": "Discount above manager authority",
  "condition": { "op": "gt", "field": "approval.totalDiscountBp", "value": 3000 },
  "approvers": [{ "type": "role", "role": "vp-sales" }],
  "mode": "sequential", "order": 20,
  "reason": "Manager authority is 30% total discount"
}
```

Approvers: `{ "type": "role", "role": … }`, `{ "type": "user", "userId": … }`, or
`{ "type": "manager-of", "userId": "owner", "levels": 1 }`. Rules sort by `order`; a
`parallel` rule's approvers act in any order. The `reason` is shown to approvers — write
it for them.

## The non-standard path

When a deal can't be expressed in the model, reps create a **non-standard** quote with free-text
lines and manual prices. It always routes to `nonStandardApprovers` (deal desk → CFO), is flagged
permanently, and shows up in the governance report. A rising non-standard rate in one area is a
request to extend the rule model.
