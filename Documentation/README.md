# Quote & Proposal Builder — Design & Build Guide

**Project:** CPQ flow with tiered pricing rules, discount approval chains, and templated proposal generation handed off to e-signature
**Language:** TypeScript
**Status of this document:** planning + reference

---

## Table of contents

1. [Executive summary and scope](#1-executive-summary-and-scope)
2. [Reality check](#2-reality-check)
3. [Decisions to make before writing code](#3-decisions-to-make-before-writing-code)
4. [Quote immutability and rule versioning](#4-quote-immutability-and-rule-versioning)
5. [The money model](#5-the-money-model)
6. [The pricing engine](#6-the-pricing-engine)
7. [Discounts and stacking](#7-discounts-and-stacking)
8. [Approval chains](#8-approval-chains)
9. [Document generation](#9-document-generation)
10. [E-signature](#10-e-signature)
11. [The downstream handoff](#11-the-downstream-handoff)
12. [Governance: who owns the rules](#12-governance-who-owns-the-rules)
13. [Testing pricing](#13-testing-pricing)
14. [Data model](#14-data-model)
15. [Tech stack and setup](#15-tech-stack-and-setup)
16. [Repository layout](#16-repository-layout)
17. [Milestone ladder](#17-milestone-ladder)
18. [Reference implementations](#18-reference-implementations)
19. [Stretch goals](#19-stretch-goals)
20. [References](#20-references)

---

## 1. Executive summary and scope

### The original statement

> CPQ flow with tiered pricing rules, discount approval chains, and templated proposal generation handed off to e-signature.

This is a well-defined, genuinely useful system. It is also in a category with a **documented ~32% success rate**, and the failure modes are specific and well-catalogued. That's unusual and it's an advantage: you can design directly against known failure modes rather than discovering them.

Five findings shape everything:

1. **CPQ implementations fail at a remarkable rate, and the reasons are documented.** Only about a third are considered fully successful by the teams that deployed them. Roughly two-thirds of Salesforce CPQ deployments require major reconfiguration within 18 months, most often in **pricing waterfall rules and bundle structure**, and it usually traces back to **no named governance owner**. Section 12 exists because of this.
2. **Quotes must be immutable and reproducible, and this must be in the schema from day one.** A quote sent to a customer is a commercial artifact. If pricing rules change next month, reopening last month's quote must show the numbers the customer actually received. Naive CPQ recomputes from live rules — which means the quote silently changes, approvals were granted against prices that no longer exist, and you cannot reproduce what was promised. Retrofitting this is a rewrite. See section 4.
3. **Discount stacking semantics and rounding rules are decisions, not implementation details.** Twenty percent plus fifteen percent is 32% multiplicatively and 35% additively — $3,000 on a $100k deal. Rounding per line versus at the total produces different totals. These must be specified before any code, because changing them later silently changes historical numbers. See sections 3 and 7.
4. **"What CPQ outputs is often not what billing and revenue recognition can ingest"** is a named, recurring failure. If your quote produces only a PDF, every downstream system is a manual re-entry. The quote must emit structured contract data. See section 11.
5. **"Shadow CPQ" is the adoption failure signal.** When the tool can't handle a real deal, people fall back to Excel, and then your system holds a fiction. The defense is a narrow honest scope plus a *sanctioned* non-standard path — because if you don't build one, an unsanctioned one gets invented. See section 12.4.

A further piece of market context worth knowing: **Salesforce moved CPQ to End-of-Sale in March 2025** — no new customers, no new features, no roadmap — with investment shifted to Revenue Cloud Advanced. The category-defining product stopped being sold to new customers. That doesn't make your project more or less viable, but it's the landscape you're describing to anyone who asks.

### Revised project statement

> A quote-to-signature system built on an immutable, versioned quote model: a deterministic pricing engine with a full audit trace, explicitly-specified discount stacking and rounding, approval chains protected by a content fingerprint, deterministic document generation, reconciled e-signature integration, and a structured contract output that downstream billing can actually ingest.

### Scope for v1

Ruthlessly narrow. CPQ scope creep is the documented killer.

**In:**
- Single currency
- New business only
- Subscription and one-time line items
- Tiered and volume pricing, percentage and amount discounts
- Sequential and parallel approval chains with thresholds
- One proposal template, PDF output
- One e-signature provider
- Structured contract output for downstream

**Explicitly out of v1** — each of these is a project:
- **Amendments, renewals, co-terming.** A mid-term upgrade prorated and co-terminated with an existing end date is where CPQ combinatorics explode. Defer it and say so.
- **Ramp deals** (different quantities in years 1/2/3)
- **Multi-currency** and FX-rate pinning
- **Usage-based / metered pricing**
- **Partner and channel margin structures**
- **Tax calculation** — this is a hard no-build. Nexus rules, VAT, GST, and reverse charge span thousands of jurisdictions and change monthly. Integrate Avalara or Stripe Tax.
- **CLM / redlining / clause libraries**
- **Revenue recognition** — you emit the data (§11); you don't compute ASC 606

---

## 2. Reality check

### 2.1 Why these systems fail

The published failure modes, with the design response each demands:

| Documented failure | Design response |
|---|---|
| **Pricing waterfall rules become unmaintainable** — the most common reason for major reconfiguration within 18 months | Explicit, ordered, versioned pipeline with a per-quote trace (§6) |
| **No named governance owner** for pricing rules | Rules are data with an owner, an approval flow of their own, and a simulation mode (§12) |
| **Bundle architecture** collapses under complexity | Defer bundles beyond simple parent/child to v2; get flat line items right first |
| **CPQ output can't be ingested by billing** | Structured contract JSON as a first-class output, not a PDF afterthought (§11) |
| **Shadow CPQ** — teams fall back to Excel | Narrow scope + a sanctioned non-standard path (§12.4) |
| **Over-customization** | Rules as data, not code. If changing a threshold requires a deploy, the system has already failed. |
| Poor data quality at the catalog level | Product catalog validation as a gate, not a warning |

### 2.2 The engineering failure modes

| Failure | Mechanism | Defense |
|---|---|---|
| **Quote reprices when rules change** | Recomputing from live rules | Pin quotes to a rule-set version; store materialized prices (§4) |
| **Floating-point money** | `0.1 + 0.2 !== 0.3` | Integer minor units, branded types (§5) |
| **Rounding drift** | Round-then-multiply vs multiply-then-round | Specify once, test exhaustively (§3.2) |
| **Discount stacking ambiguity** | Additive vs multiplicative never decided | Specify in the rule model (§7.1) |
| **Tier cliffs** | Volume pricing makes 101 units cheaper than 100 | Detect and report cliffs in tests (§13.3) |
| **Edit after approval** | Quote changed post-approval, sent at a price nobody approved | Approval fingerprint (§8.3) |
| **Missed e-sign webhooks** | Webhooks are unreliable | Polling reconciliation (§10.3) |
| **Signed document ≠ generated document** | No integrity check | Hash at generation, verify at completion (§10.4) |
| **Double-send** | Retry creates two envelopes and two contracts | Idempotency keys (§10.2) |
| **Non-deterministic PDFs** | Embedded timestamps break hashing and diffing | Normalize output (§9.3) |

### 2.3 What makes a homegrown version defensible

Commercial CPQ is mature and enormous. Three honest positions:

**Narrow fit.** Commercial CPQ is built to configure anything, which is why it takes 18 months to configure. A system that models *your* pricing exactly, with no configuration layer, can be built in months and understood completely.

**Auditability as the product.** The price trace in §6.4 — a complete, replayable record of every rule that fired and what it did — is something most commercial tools don't surface. For deal desk and audit, it's the whole game.

**It's a learning project.** Then optimize for getting the hard parts right: immutability, exact arithmetic, and the approval state machine.

---

## 3. Decisions to make before writing code

These are business decisions with permanent consequences. Write them down, get sign-off from finance, and version the document. Changing them later silently changes historical numbers.

### 3.1 Discount stacking

Given a 20% volume discount and a 15% promotional discount:

| Model | Calculation | Total discount | On $100,000 |
|---|---|---|---|
| **Additive** | 20% + 15% = 35% | 35% | $65,000 |
| **Multiplicative** | 1 − (0.80 × 0.85) | 32% | $68,000 |

$3,000 per deal. Across 500 deals a year at that size, $1.5M.

Multiplicative is more common and more defensible (each discount applies to what remains), but additive is easier for sales to reason about. **Pick one, document it, and encode it in the rule model — never leave it implicit in code.**

You also need: which discounts may stack at all, and the order of application (which matters even multiplicatively once floors are involved).

### 3.2 Rounding

Where do you round, and how?

Consider a unit price of $10.005 with quantity 1,000:

| Approach | Result |
|---|---|
| Round unit price to cents, then multiply | $10.01 × 1000 = **$10,010.00** |
| Multiply, then round the extended amount | $10,005.00 → **$10,005.00** |

A $5 difference on one line. On a large quote with many lines it compounds, and it's visible to anyone who checks your arithmetic — which, on a contract, someone will.

Decide and document:
- **Rounding mode** — half-up, half-even (banker's), half-away-from-zero. Tax authorities sometimes mandate a specific one.
- **Rounding points** — unit price? line extended amount? subtotal? total? Round at as few points as possible.
- **Precision for unit prices.** Cents is not always enough — $0.0012 per API call needs more. Pick a scale (6 decimal places is a common choice) and hold it consistently.

### 3.3 Tier model

| Model | Behavior | 101 units, tiers 1–100 @ $10, 101+ @ $8 |
|---|---|---|
| **Graduated** (like tax brackets) | First 100 at $10, remainder at $8 | 100×$10 + 1×$8 = **$1,008** |
| **Volume** (flat, land-in-tier) | All units at the tier you land in | 101×$8 = **$808** |

The volume model creates a **cliff**: 100 units costs $1,000 and 101 units costs $808. Buying more costs less. Sometimes that's intentional (it drives upsell). Usually it's an accident that someone eventually notices and exploits.

Pick per-product, make it explicit in the tier definition, and have your test suite detect cliffs and report them rather than assume they're bugs (§13.3).

### 3.4 Discount floors

- Maximum discount percentage, by product and by role
- Minimum price floor (absolute)
- Minimum margin floor (requires cost data)
- What happens when a rule would breach a floor — clamp silently, clamp and warn, or reject?

**Clamp-and-warn is usually right.** Silent clamping means a rep doesn't understand why the number moved; rejection means they can't model the deal they're trying to build.

### 3.5 Proration and term

- Does a 14-month term price as 14/12 of annual, or as annual plus 2 months?
- Day-count convention: actual days, 30/360, or whole months?
- When does the term start — signature date, or a specified start date?

These are boring and they will be the source of a customer dispute if you get them wrong.

---

## 4. Quote immutability and rule versioning ★

### 4.1 The problem

A quote is sent to a customer showing $84,320. Two weeks later, finance changes the volume discount tiers. The customer calls with a question and a rep reopens the quote — which now says $81,900.

Which number is in the contract? Which one did the VP approve? Can you reproduce the original? If the pricing engine recomputes from current rules, the answer to all three is "no."

This is the same class of problem as point-in-time correctness in data systems, but with a stricter requirement: not just *reconstructable*, but **byte-identical on every future read**.

### 4.2 The design

Three things together:

**1. Rule sets are versioned and immutable.** A published rule set is never edited. Changes create a new version.

```sql
CREATE TABLE rule_sets (
    id              BIGSERIAL PRIMARY KEY,
    version         INT NOT NULL UNIQUE,
    definition      JSONB NOT NULL,
    content_hash    TEXT NOT NULL,
    published_at    TIMESTAMPTZ NOT NULL,
    published_by    TEXT NOT NULL,
    approved_by     TEXT NOT NULL,      -- rule changes get approved too (§12.2)
    effective_from  TIMESTAMPTZ NOT NULL,
    superseded_at   TIMESTAMPTZ         -- informational; never deleted
);
```

**2. Every quote version pins the rule-set version it was priced under.**

```sql
CREATE TABLE quote_versions (
    id                BIGSERIAL PRIMARY KEY,
    quote_id          BIGINT NOT NULL REFERENCES quotes(id),
    version           INT NOT NULL,
    rule_set_version  INT NOT NULL REFERENCES rule_sets(version),
    price_book_version INT NOT NULL,
    priced_at         TIMESTAMPTZ NOT NULL,
    materialized      JSONB NOT NULL,   -- the complete priced result
    price_trace       JSONB NOT NULL,   -- how it got there (§6.4)
    content_hash      TEXT NOT NULL,
    created_by        TEXT NOT NULL,
    UNIQUE (quote_id, version)
);
```

**3. Reading a quote returns the materialized result. It never reprices.**

```ts
// Reading is a read. It does not invoke the pricing engine.
async function getQuote(quoteId: string, version?: number): Promise<PricedQuote> {
  const qv = await db.quoteVersion(quoteId, version ?? 'latest');
  return deserialize(qv.materialized);   // no pricing engine call, ever
}

// Repricing is an explicit, deliberate act that creates a NEW version.
async function reprice(quoteId: string, actor: string): Promise<PricedQuote> {
  const current = await getQuote(quoteId);
  const ruleSet = await db.currentRuleSet();
  const result = priceQuote(current.config, ruleSet);
  return db.createQuoteVersion(quoteId, result, ruleSet.version, actor);
}
```

The separation is the whole point. `getQuote` is a pure read. `reprice` is a mutation that produces a new, separately-approvable version. There is no code path where viewing a quote changes its numbers.

### 4.3 Replay as a test

Because rule sets are versioned and traces are stored, you can re-derive any historical quote:

```ts
// A regression test that runs over every historical quote.
for (const qv of await db.allQuoteVersions()) {
  const ruleSet = await db.ruleSet(qv.rule_set_version);
  const replayed = priceQuote(qv.config, ruleSet);
  assert.deepEqual(replayed, deserialize(qv.materialized),
    `quote ${qv.quote_id} v${qv.version} no longer reproduces`);
}
```

Run it in CI. If a pricing-engine change breaks the reproduction of a historical quote, that's a build failure, not a surprise discovered during an audit. This single test is the strongest guarantee the system can offer and it's cheap once immutability is in place.

---

## 5. The money model

### 5.1 Never use floating point

`0.1 + 0.2 === 0.30000000000000004`. On a contract, that is not an academic concern.

Use **integer minor units** with an explicit scale. Cents (scale 2) for totals; a higher scale (6 is common) for unit prices that need sub-cent precision.

### 5.2 Make it unrepresentable in the type system

TypeScript can enforce this with a branded type that exposes no arithmetic operators:

```ts
declare const MoneyBrand: unique symbol;

/** An exact monetary amount in minor units. Construct via the helpers;
 *  never via arithmetic on plain numbers. */
export type Money = bigint & { readonly [MoneyBrand]: true };

export const SCALE_TOTAL = 2n;   // cents
export const SCALE_UNIT  = 6n;   // unit prices

export function money(minorUnits: bigint): Money {
  return minorUnits as Money;
}

export function add(a: Money, b: Money): Money {
  return (a + b) as Money;
}

/** Multiply by an integer quantity. Exact; no rounding needed. */
export function mulQty(a: Money, qty: bigint): Money {
  return (a * qty) as Money;
}

/** Apply a rate expressed as basis points (10000 bp = 100%).
 *  Rounding mode is explicit at every call site — there is no default. */
export function applyRate(a: Money, bp: bigint, mode: RoundingMode): Money {
  return divRound(a * bp, 10_000n, mode) as Money;
}

export function divRound(num: bigint, den: bigint, mode: RoundingMode): bigint {
  const q = num / den;
  const r = num % den;
  if (r === 0n) return q;
  switch (mode) {
    case 'half-up': {
      const twice = (r < 0n ? -r : r) * 2n;
      const up = twice >= den ? 1n : 0n;
      return q + (num < 0n ? -up : up);
    }
    case 'half-even': { /* banker's rounding */ }
    case 'down':      return q;
  }
}
```

Two properties this buys you:

- **You cannot accidentally add a `Money` to a `number`.** The compiler rejects it.
- **Every rounding decision is at a call site with an explicit mode.** There is no library default silently doing something different from what finance specified.

Express discounts and rates as **basis points**, not floats. 15% is `1500n`. This keeps the entire pipeline in exact integer arithmetic until a deliberate rounding step.

### 5.3 Currency is part of the type

Even in a single-currency v1, carry the currency code on every amount and assert on it in `add`. The day someone adds a second currency, the compiler and the assertions find every place that needs attention — instead of silently summing dollars and euros.

---

## 6. The pricing engine

### 6.1 A deterministic, ordered pipeline

The documented failure mode is the pricing waterfall becoming unmaintainable. The defense is to make the waterfall an explicit, ordered, inspectable sequence of stages rather than a set of rules that fire in emergent order.

```
 configure    resolve bundle, validate requires/excludes
      ↓
 base price   list price from the pinned price book version
      ↓
 tiers        graduated or volume, per the product's tier model
      ↓
 discounts    applied in declared order, per stacking semantics
      ↓
 floors       clamp to max-discount / min-price / min-margin
      ↓
 round        per the declared rounding points and mode
      ↓
 line totals  extended amounts
      ↓
 order level  order-wide discounts, then round again
      ↓
 tax          delegated to Avalara / Stripe Tax
      ↓
 materialize  write the immutable result + trace
```

Each stage is a pure function from `(state, ruleSet) → (state, traceEntries)`. No stage reads the clock, the database, or anything outside its inputs.

```ts
export type Stage = (s: PricingState, rs: RuleSet) => StageResult;

export function priceQuote(config: QuoteConfig, rs: RuleSet): PricedQuote {
  let state = initialState(config);
  const trace: TraceEntry[] = [];

  for (const stage of PIPELINE) {
    const result = stage(state, rs);
    state = result.state;
    trace.push(...result.trace);
  }

  return { ...materialize(state), trace, ruleSetVersion: rs.version };
}
```

### 6.2 Determinism is a hard requirement

The pricing engine must be a pure function. Same inputs, same rule set, byte-identical output, forever. That means:

- **No `Date.now()`** inside the engine. Time-dependent rules take an explicit `asOf` parameter that is part of the pinned inputs.
- **No random**, no UUID generation inside pricing.
- **No I/O.** Price books, catalogs, and rules are loaded before the engine runs and passed in.
- **Stable iteration order.** Never iterate a `Map` or object whose insertion order depends on upstream nondeterminism. Sort explicitly before iterating.

This is what makes §4.3's replay test possible, and it makes the engine trivially testable.

### 6.3 Rules are data

A rule is a declarative record, not code:

```ts
type DiscountRule = {
  id: string;
  name: string;
  priority: number;                  // explicit application order
  stackable: boolean;
  stackGroup?: string;               // rules in a group are mutually exclusive
  condition: Condition;              // a constrained expression tree
  effect: { type: 'percent'; basisPoints: number }
        | { type: 'amount'; minorUnits: string }
        | { type: 'overridePrice'; minorUnits: string };
  requiresApproval?: { role: string; threshold?: Threshold };
};
```

**Do not embed a general scripting language.** A `Condition` should be a constrained expression tree over known fields and operators — comparisons, boolean combinations, set membership. That gives you:

- Static validation at publish time
- No sandbox-escape surface
- Analyzability — you can ask "which rules could apply to this product?" without executing anything
- Safe authoring by non-engineers

A rule engine that lets a deal-desk analyst write arbitrary JavaScript is a remote-code-execution vector with a friendly UI.

### 6.4 The price trace ★

Every stage emits trace entries. The trace is stored with the quote and is the answer to "why is this number what it is?"

```ts
type TraceEntry = {
  stage: string;
  lineId?: string;
  ruleId?: string;
  ruleName?: string;
  before: Money;
  after: Money;
  delta: Money;
  explanation: string;     // human-readable, for the UI
  inputs: Record<string, unknown>;
};
```

Rendered in the UI:

```
Line: Platform License × 250 seats

  List price                    $200.00/seat      $50,000.00
  Volume tier (200–499)         −$40.00/seat      $40,000.00
    rule: tier_platform_v3, graduated
  Partner discount 10%          −$4,000.00        $36,000.00
    rule: partner_gold, stackable, priority 20
  Promo discount 5%             −$1,800.00        $34,200.00
    rule: q3_promo, stackable, priority 30, multiplicative
  Floor check                   no change         $34,200.00
    max discount 40%, actual 31.6% — OK
  Rounding (half-up, line)      $0.00             $34,200.00
                                                  ──────────
                                                  $34,200.00
```

This is what deal desk needs to approve confidently, what an auditor needs two years later, and what you need to debug. It's also the feature that most distinguishes a well-built system from a black box.

**Build the trace from the first stage you write**, not as an afterthought. Retrofitting it means threading a context parameter through every function you've already written.

---

## 7. Discounts and stacking

### 7.1 Stacking semantics in the rule model

Make the semantics explicit data, never an implicit property of the code:

```ts
type StackingPolicy = {
  mode: 'additive' | 'multiplicative';
  /** Rules within the same group are mutually exclusive; highest priority wins. */
  exclusiveGroups: string[];
  /** Rule IDs that may never combine, regardless of group. */
  incompatible: Array<[string, string]>;
  maxTotalBasisPoints: number;     // a hard ceiling after all stacking
};
```

### 7.2 Application

```ts
function applyDiscounts(s: PricingState, rs: RuleSet): StageResult {
  const trace: TraceEntry[] = [];

  for (const line of s.lines) {
    // Deterministic order: priority, then id as a tiebreak.
    const applicable = rs.discountRules
      .filter(r => evaluate(r.condition, line, s))
      .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));

    const selected = resolveExclusivity(applicable, rs.stacking);

    for (const rule of selected) {
      const before = line.unitPrice;
      line.unitPrice = applyEffect(line.unitPrice, rule.effect, rs.stacking.mode, rs.rounding);
      trace.push({
        stage: 'discounts',
        lineId: line.id,
        ruleId: rule.id,
        ruleName: rule.name,
        before,
        after: line.unitPrice,
        delta: sub(line.unitPrice, before),
        explanation: describe(rule, rs.stacking.mode),
        inputs: { priority: rule.priority, mode: rs.stacking.mode },
      });
    }
  }
  return { state: s, trace };
}
```

The `|| a.id.localeCompare(b.id)` tiebreak matters. Two rules with the same priority must apply in a stable order or the engine isn't deterministic — and in multiplicative mode with floors, order changes the result.

### 7.3 Floors

Floors clamp after all discounts, and the clamp itself is traced:

```ts
function applyFloors(s: PricingState, rs: RuleSet): StageResult {
  const trace: TraceEntry[] = [];
  for (const line of s.lines) {
    const floor = resolveFloor(line, rs);
    if (line.unitPrice < floor) {
      trace.push({
        stage: 'floors',
        lineId: line.id,
        before: line.unitPrice,
        after: floor,
        delta: sub(floor, line.unitPrice),
        explanation: `clamped to floor ${fmt(floor)} (${floor_reason(line, rs)})`,
        inputs: { floorType: floor.type },
      });
      line.unitPrice = floor;
      line.floorClamped = true;      // surfaced in the UI as a warning
    }
  }
  return { state: s, trace };
}
```

Surfacing `floorClamped` in the UI is what makes clamp-and-warn work. A rep who applies a 60% discount and sees 40% with no explanation will assume the system is broken and go make a spreadsheet.

---

## 8. Approval chains

### 8.1 Resolution

Given a priced quote, compute the required approvers:

```ts
type ApprovalRule = {
  id: string;
  condition: Condition;     // over discount %, TCV, margin, term, custom flags
  approvers: ApproverSpec[];
  mode: 'sequential' | 'parallel';
  order: number;
};

type ApproverSpec =
  | { type: 'role'; role: string }
  | { type: 'user'; userId: string }
  | { type: 'manager-of'; userId: string; levels: number };
```

Typical triggers: discount above a threshold, total contract value above a threshold, margin below a floor, non-standard payment terms, non-standard legal terms, term length outside the norm.

Resolve into an ordered plan, and **store the plan** with the quote version. If the approval-rule set changes mid-flight, the in-flight approval should follow the plan it started with.

### 8.2 The state machine

```
   DRAFT ──submit──▶ PENDING_APPROVAL ──all approved──▶ APPROVED
     ▲                   │      │                          │
     │                   │      │ rejected                 │ send
     │            edit   │      ▼                          ▼
     └───────────────────┘   REJECTED                    SENT
     │                                                     │
     │                                    ┌────────────────┼──────────────┐
     │                                    ▼                ▼              ▼
     └──────────── recalled ──────────  VIEWED          SIGNED         DECLINED
                                                           │              │
                                                           ▼           EXPIRED
                                                        CLOSED_WON     VOIDED
```

Rules:
- **Terminal states are terminal.** `CLOSED_WON`, `DECLINED`, `EXPIRED`, `VOIDED`.
- **Editing from any pre-send state returns to `DRAFT`** and creates a new quote version.
- **Every transition is an append-only event**, never an in-place status update. The event log is the audit trail.

### 8.3 The approval fingerprint ★

**The hole every homegrown approval system has:** a quote is approved at a 20% discount, then edited to 45%, then sent. The approval record still says "approved," and it now refers to a price nobody approved.

The fix is a hash over exactly the fields that affect the approval decision:

```ts
/** Hash of everything that could change the approval decision.
 *  Deliberately excludes cosmetic fields — changing the proposal's
 *  intro paragraph should not void a VP's approval. */
export function approvalFingerprint(q: PricedQuote): string {
  const material = {
    lines: q.lines
      .map(l => ({
        productId: l.productId,
        quantity: l.quantity.toString(),
        unitPrice: l.unitPrice.toString(),
        extended: l.extended.toString(),
        discountBp: l.totalDiscountBasisPoints,
        termMonths: l.termMonths,
      }))
      .sort((a, b) => a.productId.localeCompare(b.productId)),
    total: q.total.toString(),
    currency: q.currency,
    paymentTerms: q.paymentTerms,
    legalTermsVersion: q.legalTermsVersion,
    startDate: q.startDate,
  };
  return sha256(canonicalJson(material));
}
```

Then every approval records the fingerprint it approved, and sending checks it:

```ts
async function send(quoteId: string): Promise<void> {
  const q = await getQuote(quoteId);
  const approvals = await db.approvals(quoteId);
  const current = approvalFingerprint(q);

  const stale = approvals.filter(a => a.fingerprint !== current);
  if (stale.length > 0) {
    throw new ApprovalInvalidatedError(
      `Quote changed since approval. Re-approval required from: ` +
      stale.map(a => a.approverName).join(', ')
    );
  }
  // ... proceed
}
```

Note the deliberate exclusions. If the fingerprint covers the entire quote document, fixing a typo in the cover letter voids the CFO's approval, and people will learn to route around the approval system. Covering exactly the material terms — and documenting which fields those are — is what makes the control usable.

### 8.4 The operational details

These are what separate a working approval system from a demo:

- **Delegation.** An approver on holiday must be able to delegate, with the delegation recorded.
- **Escalation.** After N business hours, escalate to the approver's manager. Business hours, not wall-clock — a quote submitted Friday at 5pm shouldn't escalate over the weekend.
- **Parallel approvals** genuinely in parallel. Legal and finance reviewing sequentially doubles cycle time for no reason.
- **Recall.** A rep must be able to withdraw a submission.
- **Approve with conditions.** "Approved if the term goes to 36 months" is extremely common in practice and is otherwise handled by out-of-band email, which destroys the audit trail.
- **Notification with context.** An approval request that says "Quote #4471 needs approval" gets ignored. One that says "32% discount on $180k, 8 points above policy, because [reason from the rep]" gets actioned.

---

## 9. Document generation

### 9.1 Choosing an approach

| Approach | Pros | Cons |
|---|---|---|
| **HTML + CSS Paged Media → PDF** (headless Chrome) | Familiar tooling, good tables, easy iteration | Heavy runtime, nondeterministic output by default, CSS paged-media support is uneven |
| **Typst** | Fast, deterministic, designed for typesetting, small binary | Newer, smaller ecosystem |
| **LaTeX** | Excellent typesetting | Painful templating, heavy toolchain |
| **DOCX template + LibreOffice** | Business users can edit the template | LibreOffice as a runtime dependency, fragile conversion |

**Recommendation: HTML/CSS → PDF for v1** because iteration speed matters most while the template is still changing, with the determinism fixes in §9.3. Evaluate Typst if deterministic output and runtime weight become problems.

### 9.2 The hard parts of proposal documents

Not the templating — the layout:

- **Tables that span pages** need repeating headers and must not orphan a row
- **Page breaks in sensible places** — `break-inside: avoid` on line-item groups
- **Headers and footers with page numbers** — `@page` margin boxes
- **Conditional sections** — show the SLA appendix only for enterprise tiers
- **Long product names and descriptions** that overflow their cell
- **Signature blocks** positioned so the e-sign provider's anchor tags land correctly

That last one is a specific gotcha: e-signature providers place fields using anchor text or absolute coordinates. If your layout shifts because a product name wrapped to two lines, the signature field can land in the wrong place. **Use anchor-text positioning, not coordinates**, and put the anchor in a fixed-position block.

### 9.3 Determinism ★

You are going to hash this document (§10.4), so it must be reproducible.

Sources of nondeterminism to eliminate:

- **PDF creation/modification timestamps.** Set them explicitly to the quote's `priced_at`, not "now."
- **Embedded font subsets** may vary by generation run. Embed full fonts, or pin the toolchain version.
- **PDF object ordering** and the document ID. Post-process to normalize.
- **Any "generated on" date** in the template. Use the quote timestamp.

```ts
async function generate(quote: PricedQuote, template: Template): Promise<GeneratedDoc> {
  const html = render(template, { quote, generatedAt: quote.pricedAt });
  const pdf = await htmlToPdf(html, {
    // Fixed metadata — never Date.now()
    creationDate: quote.pricedAt,
    modDate: quote.pricedAt,
    producer: `quote-builder/${TEMPLATE_ENGINE_VERSION}`,
  });
  const normalized = normalizePdf(pdf);       // strip/fix nondeterministic bits
  return {
    bytes: normalized,
    sha256: sha256(normalized),
    templateVersion: template.version,
    quoteVersion: quote.version,
  };
}
```

**Test it:** generate the same quote twice and assert byte equality. Put that in CI. It fails the first time and teaches you exactly which fields were nondeterministic.

### 9.4 Templates are versioned too

Same discipline as rule sets. A quote records the template version it was rendered with, and published templates are immutable. Otherwise "regenerate the PDF for that deal from last quarter" produces a different document.

---

## 10. E-signature

### 10.1 Provider abstraction, lightly

Abstract enough to test without network calls; don't build a universal adapter for providers you'll never use.

```ts
interface ESignProvider {
  createEnvelope(req: EnvelopeRequest, idempotencyKey: string): Promise<EnvelopeRef>;
  getEnvelope(id: string): Promise<EnvelopeStatus>;
  void(id: string, reason: string): Promise<void>;
  downloadCompleted(id: string): Promise<{ bytes: Buffer; certificate: Buffer }>;
  verifyWebhook(headers: Headers, rawBody: Buffer): WebhookEvent;
}
```

A `FakeESignProvider` that can be driven through every state — including declined, expired, and voided — is what makes §10.3 testable without a sandbox account.

### 10.2 Idempotency

A retry that creates a second envelope means the customer receives two contracts. Generate an idempotency key deterministically from the content:

```ts
const idempotencyKey = sha256(`${quoteId}:${quoteVersion}:${documentHash}`);
```

Store the mapping from key to envelope ID before calling the provider, so a crash between the call and the response is recoverable — on retry you find the existing key, query the provider, and reconcile rather than sending again.

### 10.3 Webhooks are unreliable; reconcile by polling ★

Every e-signature integration that relies solely on webhooks eventually has a contract that was signed days ago and is still showing as "sent," because one webhook was dropped, or your endpoint was down during a deploy, or the provider had an incident.

Run both:

```ts
// Webhooks: fast path.
async function onWebhook(headers: Headers, rawBody: Buffer): Promise<void> {
  const event = provider.verifyWebhook(headers, rawBody);   // HMAC + replay window
  await applyEnvelopeEvent(event);                          // idempotent
}

// Polling: the safety net. Every 15 minutes.
async function reconcile(): Promise<void> {
  const open = await db.enveloopesInNonTerminalState({ olderThan: minutes(10) });
  for (const env of open) {
    const status = await provider.getEnvelope(env.providerId);
    if (status.state !== env.state) {
      logger.warn('envelope drift detected — webhook likely missed', {
        envelopeId: env.id, local: env.state, remote: status.state,
      });
      await applyEnvelopeEvent(toEvent(status));
    }
  }
}
```

**Log the drift.** A rising rate of reconciliation-detected changes means your webhook endpoint is broken, and that's a signal you want before a customer tells you.

`applyEnvelopeEvent` must be idempotent — webhook and poll will frequently both deliver the same transition.

### 10.4 Verify the signed document is yours

The provider returns a completed PDF. Confirm it's the document you generated:

```ts
async function onCompleted(envelopeId: string): Promise<void> {
  const { bytes, certificate } = await provider.downloadCompleted(envelopeId);
  const env = await db.envelope(envelopeId);

  // The signed PDF has the signature overlay, so it won't hash identically
  // to the original. Verify the underlying content instead.
  const embeddedHash = await extractOriginalHash(bytes);
  if (embeddedHash !== env.documentHash) {
    await flagForReview(envelopeId, 'signed document does not match generated document');
    return;
  }

  await db.storeExecutedContract(env.quoteId, bytes, certificate);
  await transition(env.quoteId, 'CLOSED_WON');
}
```

Practical approach: embed the generated document's hash as PDF metadata or a visible footer reference before sending, then read it back from the completed document. Simpler than trying to reverse the provider's overlay.

**Store the completion certificate.** That's the provider's audit trail — IP addresses, timestamps, authentication events — and it's what gives the signature legal weight under ESIGN and eIDAS. Losing it undermines enforceability. Store it alongside the executed contract, permanently.

### 10.5 The awkward states

| State | Handling |
|---|---|
| **Customer signs a superseded version** | You sent v3, then created v4 internally. The signature is on v3, and v3 is what's binding. Void proactively when superseding, or accept and reconcile explicitly. Decide, don't discover. |
| **Partial signature** (multi-signer) | Track per-recipient state, not just envelope state |
| **Declined** | Capture the reason; return the quote to a workable state |
| **Expired** | Configurable expiry; notify before it happens, not after |
| **Voided after signature** | Requires an amendment flow; out of v1 scope but the state must exist |
| **Customer edits the PDF** | Providers prevent this; if your hash check fails, escalate rather than accept |

---

## 11. The downstream handoff

**"What CPQ outputs is often not what billing and revenue recognition can ingest"** is a documented recurring failure. If the only artifact is a PDF, every downstream system needs a human to re-key it — which means errors, delay, and drift between what was sold and what gets billed.

### 11.1 Emit structured contract data

The executed quote produces a machine-readable contract alongside the PDF:

```ts
type ExecutedContract = {
  contractId: string;
  quoteId: string;
  quoteVersion: number;
  documentHash: string;
  executedAt: string;              // ISO 8601
  currency: string;

  customer: { accountId: string; billingAddress: Address; taxIds: TaxId[] };

  term: {
    startDate: string;
    endDate: string;
    months: number;
    autoRenew: boolean;
    noticePeriodDays: number;
  };

  lines: Array<{
    lineId: string;
    productId: string;
    sku: string;
    quantity: string;              // string to preserve exactness
    unitPriceMinorUnits: string;
    extendedMinorUnits: string;
    discountBasisPoints: number;
    // Everything downstream needs and cannot infer from a PDF:
    billingFrequency: 'monthly' | 'quarterly' | 'annual' | 'one-time';
    recognitionMethod: 'ratable' | 'point-in-time';
    standaloneSellingPriceMinorUnits: string;   // for ASC 606 allocation
    serviceStartDate: string;
    serviceEndDate: string;
  }>;

  paymentTerms: { netDays: number; method: string };
  totalMinorUnits: string;
  ruleSetVersion: number;
};
```

The fields that matter most and are most often missing: **billing frequency, recognition method, standalone selling price, and per-line service dates.** Without SSP, revenue allocation under ASC 606 is manual. Without service dates, ratable recognition is manual. These are cheap to capture at quote time and expensive to reconstruct later.

You are not computing revenue recognition. You are making it *possible* — which is the difference between a CPQ that fits into a quote-to-cash flow and one that becomes a documented failure case.

### 11.2 Emit it as an event

```ts
await events.publish('contract.executed', {
  contract: executedContract,
  idempotencyKey: `contract-executed:${contractId}`,
});
```

Downstream consumers — billing, provisioning, CRM, finance — subscribe. Idempotency key so redelivery is safe. Append-only, so replaying the full history rebuilds any consumer's state.

---

## 12. Governance: who owns the rules

The most commonly cited root cause of CPQ reconfiguration is **no named governance owner**. This is an organizational problem with a technical component, and the technical component is what determines whether governance is possible at all.

### 12.1 Rules must be data, editable without a deploy

If changing a discount threshold requires an engineer, a pull request, and a release, then one of two things happens: changes don't get made, or they get made by someone bypassing the system. Both are how you end up with shadow CPQ.

So: rules are data, with an authoring UI, owned by deal desk or finance.

### 12.2 But rule changes need their own approval flow

User-editable pricing rules are user-editable revenue. Someone can publish a rule granting 100% discounts. So the rule lifecycle mirrors the quote lifecycle:

```
DRAFT ──▶ SIMULATED ──▶ PENDING_APPROVAL ──▶ PUBLISHED (immutable)
```

- **Simulation is mandatory before approval.** Re-price the last N closed quotes under the proposed rule set and show the delta. "This change would have reduced revenue on the last 200 deals by $340k" is the single most useful screen in the admin UI, and it turns rule review from a guess into a measurement.
- **Publication requires approval** from a named owner.
- **Published rule sets are immutable** — that's §4.
- **Diff view** between versions, so a reviewer sees exactly what changed.

```ts
async function simulate(proposed: RuleSet, sampleSize = 200): Promise<SimulationReport> {
  const recent = await db.recentClosedQuotes(sampleSize);
  const deltas = recent.map(q => {
    const current = deserialize(q.materialized);
    const repriced = priceQuote(q.config, proposed);
    return {
      quoteId: q.quote_id,
      before: current.total,
      after: repriced.total,
      delta: sub(repriced.total, current.total),
      newlyRequiresApproval: requiredApprovals(repriced).length > requiredApprovals(current).length,
    };
  });
  return summarize(deltas);
}
```

The `newlyRequiresApproval` flag is worth the extra line: a threshold change that quietly routes 40% more quotes through the CFO is a change in operational load, not just in pricing, and the person approving the rule should see it.

### 12.3 Effective dating

A rule change is often meant to take effect on a future date — the start of a quarter, a new price list. Support `effective_from`, and make quotes pin to the rule set effective at their pricing time. Retroactive rule changes should be impossible through the UI.

### 12.4 The sanctioned escape hatch ★

**Shadow CPQ happens when the tool can't do the deal.** A rep needs a structure the system doesn't model, so they build a spreadsheet, and the system now holds a fiction.

You cannot prevent this by making the system handle everything — that's the 18-month implementation that fails. You prevent it by building a *sanctioned* non-standard path:

- A "non-standard deal" quote type with free-text line items and a manually entered total
- Which **always** routes to the highest approval tier
- And is **flagged permanently** on the record, so it's visible in reporting

This gives you three things: the deal stays in the system, finance sees it, and the frequency of non-standard quotes becomes a measurable signal of where the rule model is inadequate. A rising rate in one product line is a feature request with evidence attached.

Without this, the same deals happen anyway, in Excel, invisibly.

---

## 13. Testing pricing

### 13.1 Golden fixtures

A corpus of `(configuration, rule set) → expected priced output` files, checked into the repo.

```
tests/golden/
  ├── simple_single_line.json
  ├── volume_tier_boundary_99.json
  ├── volume_tier_boundary_100.json
  ├── volume_tier_boundary_101.json
  ├── stacked_discounts_multiplicative.json
  ├── floor_clamp_triggered.json
  ├── rounding_half_up_edge.json
  └── ...
```

Each fixture pins its rule-set version, so fixtures remain valid as rules evolve. **When a fixture's expected output changes, that must be a deliberate, reviewed commit** — a diff in a golden file is a pricing change and should be read as one.

### 13.2 Property tests

```ts
test('total equals sum of line extended amounts', () => {
  fc.assert(fc.property(arbitraryQuote(), (q) => {
    const p = priceQuote(q, ruleSet);
    expect(p.total).toEqual(p.lines.reduce((a, l) => add(a, l.extended), ZERO));
  }));
});

test('discount never breaches the configured floor', () => {
  fc.assert(fc.property(arbitraryQuote(), (q) => {
    const p = priceQuote(q, ruleSet);
    for (const line of p.lines) {
      expect(line.unitPrice).toBeGreaterThanOrEqual(resolveFloor(line, ruleSet));
    }
  }));
});

test('pricing is deterministic', () => {
  fc.assert(fc.property(arbitraryQuote(), (q) => {
    expect(priceQuote(q, ruleSet)).toEqual(priceQuote(q, ruleSet));
  }));
});
```

### 13.3 Cliff detection

Volume tiers create discontinuities where buying more costs less. Detect them rather than asserting they don't exist:

```ts
test('report all tier cliffs', () => {
  const cliffs: Cliff[] = [];
  for (const product of catalog.products) {
    let prev: Money | null = null;
    for (let qty = 1; qty <= product.maxTestQty; qty++) {
      const total = priceQuote(singleLine(product, qty), ruleSet).total;
      if (prev !== null && total < prev) {
        cliffs.push({ productId: product.id, atQuantity: qty, saving: sub(prev, total) });
      }
      prev = total;
    }
  }
  // Cliffs are not always bugs — but every one must be in the allowlist,
  // which means someone deliberately decided it.
  expect(cliffs).toEqual(EXPECTED_CLIFFS);
});
```

The allowlist is the point. An unexpected cliff fails the build; an intended one is documented with a reason.

### 13.4 Replay regression

Section 4.3 — re-derive every historical quote in CI. Non-negotiable once you have quotes in production.

### 13.5 Rounding torture tests

Amounts designed to sit exactly on rounding boundaries: `$x.xx5`, quantities that produce repeating decimals, discount percentages that don't divide evenly. These are where money quietly goes missing.

---

## 14. Data model

```sql
-- Catalog and rules: versioned, immutable once published
CREATE TABLE products        (id, sku, name, tier_model, active, ...);
CREATE TABLE price_books     (id, version, currency, published_at, ...);
CREATE TABLE price_book_entries (price_book_version, product_id,
                                 list_price_minor BIGINT, ...);
CREATE TABLE rule_sets       (version, definition JSONB, content_hash,
                              published_at, approved_by, effective_from);

-- Quotes: append-only versions
CREATE TABLE quotes (
    id           BIGSERIAL PRIMARY KEY,
    account_id   BIGINT NOT NULL,
    owner_id     TEXT NOT NULL,
    state        TEXT NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL
);

CREATE TABLE quote_versions (
    id                 BIGSERIAL PRIMARY KEY,
    quote_id           BIGINT NOT NULL REFERENCES quotes(id),
    version            INT NOT NULL,
    config             JSONB NOT NULL,   -- the input
    materialized       JSONB NOT NULL,   -- the priced output
    price_trace        JSONB NOT NULL,
    rule_set_version   INT NOT NULL REFERENCES rule_sets(version),
    price_book_version INT NOT NULL,
    approval_fingerprint TEXT NOT NULL,
    content_hash       TEXT NOT NULL,
    priced_at          TIMESTAMPTZ NOT NULL,
    created_by         TEXT NOT NULL,
    UNIQUE (quote_id, version)
);

-- Everything that happens is an event, never an UPDATE
CREATE TABLE quote_events (
    id            BIGSERIAL PRIMARY KEY,
    quote_id      BIGINT NOT NULL,
    quote_version INT,
    type          TEXT NOT NULL,     -- submitted, approved, sent, signed, ...
    actor         TEXT NOT NULL,
    payload       JSONB NOT NULL,
    occurred_at   TIMESTAMPTZ NOT NULL
);

CREATE TABLE approvals (
    id            BIGSERIAL PRIMARY KEY,
    quote_id      BIGINT NOT NULL,
    quote_version INT NOT NULL,
    approver_id   TEXT NOT NULL,
    role          TEXT NOT NULL,
    fingerprint   TEXT NOT NULL,     -- ★ what they actually approved
    decision      TEXT NOT NULL,     -- approved | rejected | conditional
    conditions    TEXT,
    decided_at    TIMESTAMPTZ NOT NULL
);

CREATE TABLE documents (
    id               BIGSERIAL PRIMARY KEY,
    quote_id         BIGINT NOT NULL,
    quote_version    INT NOT NULL,
    template_version INT NOT NULL,
    sha256           TEXT NOT NULL,
    storage_key      TEXT NOT NULL,
    generated_at     TIMESTAMPTZ NOT NULL
);

CREATE TABLE envelopes (
    id              BIGSERIAL PRIMARY KEY,
    quote_id        BIGINT NOT NULL,
    document_id     BIGINT NOT NULL REFERENCES documents(id),
    provider        TEXT NOT NULL,
    provider_id     TEXT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    state           TEXT NOT NULL,
    sent_at         TIMESTAMPTZ,
    completed_at    TIMESTAMPTZ
);
```

**No `UPDATE` on quote data.** New versions, new events. The only mutable column in the system is `quotes.state`, and even that is derivable from the event log — keeping it is a denormalization for query convenience, and it should be reconstructable as a consistency check.

---

## 15. Tech stack and setup

### 15.1 Choices

| Layer | Choice | Why |
|---|---|---|
| **Language** | TypeScript | The quote builder UI is half the product; one language front to back. **See the caveat below.** |
| **Money** | `bigint` + branded types | See §5.2. Never `number`. |
| **Database** | PostgreSQL | JSONB for rule definitions and materialized quotes, real transactions, `NUMERIC`/`BIGINT` for money |
| **ORM** | Drizzle or Kysely | Typed SQL without hiding it. Avoid heavy ORMs — this schema is deliberate. |
| **API** | tRPC or a typed REST layer | End-to-end types between the builder UI and the engine |
| **UI** | React + TanStack Query | The quote builder is a complex form; invest here |
| **PDF** | Playwright/Chromium → PDF | With the determinism fixes in §9.3 |
| **Templating** | Handlebars or Eta | Deliberately limited — logic belongs in the engine, not the template |
| **E-signature** | DocuSign or Dropbox Sign | Behind the §10.1 interface |
| **Tax** | Avalara or Stripe Tax | Never build |
| **Testing** | Vitest + fast-check | Property tests are essential here |

**The TypeScript caveat.** JavaScript numbers are IEEE-754 doubles, which makes TS a slightly awkward home for exact monetary arithmetic. The branded-`bigint` approach in §5.2 closes the hole, and the compiler enforces it — but the discipline has to be in place from the first commit. Go (with a decimal package), Python (`Decimal`), or C# (native `decimal`) give you a better native story if you'd rather not rely on convention plus types. The argument for TS is that a CPQ is a UI-heavy product and sharing types between the quote builder and the pricing engine is genuinely valuable.

### 15.2 Setup

```bash
pnpm create vite quote-builder --template react-ts
pnpm add -D vitest fast-check @types/node tsx
pnpm add drizzle-orm postgres zod handlebars playwright

docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=dev postgres:16

pnpm drizzle-kit generate
pnpm tsx scripts/seed-catalog.ts
```

Enable `strict`, `noUncheckedIndexedAccess`, and `exactOptionalPropertyTypes` in `tsconfig.json`. In a system where a type error can mean a mispriced contract, the strictest available settings are the correct ones.

---

## 16. Repository layout

```
Quote-and-Proposal-Builder/
├── README.md
├── docs/
│   ├── design.md                ← this document
│   ├── pricing-semantics.md     ← ★ the §3 decisions, signed off by finance
│   ├── rule-authoring.md        ← for deal desk
│   └── downstream-contract.md   ← the §11 schema, for billing
├── packages/
│   ├── money/                   ← branded types, exact arithmetic, rounding
│   │   └── src/
│   ├── pricing/                 ← ★ pure, deterministic, no I/O
│   │   ├── src/
│   │   │   ├── pipeline.ts
│   │   │   ├── stages/
│   │   │   │   ├── configure.ts
│   │   │   │   ├── basePrice.ts
│   │   │   │   ├── tiers.ts
│   │   │   │   ├── discounts.ts
│   │   │   │   ├── floors.ts
│   │   │   │   └── rounding.ts
│   │   │   ├── conditions.ts    ← the constrained expression evaluator
│   │   │   └── trace.ts
│   │   └── tests/
│   │       ├── golden/
│   │       ├── properties.test.ts
│   │       ├── cliffs.test.ts
│   │       └── replay.test.ts   ← ★ every historical quote
│   ├── rules/                   ← authoring, validation, versioning, simulation
│   ├── approvals/               ← chain resolution, fingerprint, state machine
│   ├── documents/               ← templating, PDF, determinism
│   ├── esign/
│   │   ├── src/
│   │   │   ├── provider.ts
│   │   │   ├── docusign.ts
│   │   │   ├── fake.ts          ← drives every state, for tests
│   │   │   └── reconcile.ts
│   └── contracts/               ← the §11 structured output
├── apps/
│   ├── api/
│   ├── builder/                 ← the quote builder UI
│   └── admin/                   ← rule authoring + simulation
└── db/
    └── migrations/
```

`packages/pricing` has **no dependencies on the database, the network, or the clock.** That constraint is what makes it testable, replayable, and trustworthy. Enforce it with a lint rule if you can.

---

## 17. Milestone ladder

### M0 — Pricing semantics ★ **before any code**
**Est. 4–5 days**

Write `docs/pricing-semantics.md`: stacking mode, rounding points and mode, precision, tier models, floor behavior, proration and day-count conventions. **Get finance to sign off in writing.**

These are business decisions with permanent consequences, and discovering in month four that finance assumed multiplicative while you built additive means re-pricing every quote in the system.

**Done when:** a signed document exists and every open question in §3 has an answer.

---

### M1 — Money
**Est. 3–4 days**

Branded types, exact arithmetic, all rounding modes, basis points, currency, exhaustive property tests including the boundary cases.

**Done when:** it is a compile error to add a `Money` to a `number`, and rounding is correct at every `.xx5` boundary in both signs.

---

### M2 — Data model and immutability ★
**Est. 1 week**

Schema, migrations, append-only quote versions, event log, rule-set versioning.

**Done when:** `getQuote` provably never calls the pricing engine, and a test asserts that repricing creates a new version rather than mutating one.

---

### M3 — The pricing engine
**Est. 2.5 weeks**

The full pipeline, the condition evaluator, and the trace — **the trace from the first stage, not retrofitted.** Golden fixtures and property tests alongside.

**Done when:** determinism, floor, and cliff tests pass, and the trace renders as a readable waterfall.

---

### M4 — Rule authoring and simulation
**Est. 1.5 weeks**

Admin UI, validation at publish, diff view, the rule approval flow, and **simulation against recent quotes**.

**Done when:** a deal-desk analyst can change a threshold, see the revenue impact on the last 200 deals, and publish only with approval.

---

### M5 — Approval chains
**Est. 1.5 weeks**

Chain resolution, the state machine, the fingerprint, delegation, escalation on business hours, parallel approvals, approve-with-conditions.

**Write the abuse test first:** approve a quote, edit the discount, attempt to send. It must be refused and the refusal must name who needs to re-approve.

---

### M6 — Document generation
**Est. 1.5 weeks**

Template engine, page-break handling, conditional sections, determinism, versioning.

**Done when:** generating the same quote twice produces byte-identical PDFs, asserted in CI.

---

### M7 — E-signature
**Est. 1.5 weeks**

Provider interface, fake provider, idempotency, webhook verification, polling reconciliation, hash verification, certificate storage.

**Done when:** the fake provider can drive every state including declined, expired, and voided, and dropping a webhook in the test still converges via reconciliation.

---

### M8 — The downstream contract
**Est. 1 week**

Structured `ExecutedContract` output, event publication, idempotency.

**Done when:** someone from billing has looked at the schema and confirmed they could ingest it. Not "you think they could" — they've said so.

---

### M9 — The builder UI
**Est. 2.5 weeks**

The quote builder, the price trace view, approval status, document preview, send flow.

The trace view is the feature people will remember. Give it real attention.

---

### M10 — Governance and hardening
**Est. 1.5 weeks**

The non-standard deal path, reporting on non-standard frequency, replay regression in CI, permissions, audit export.

---

## 18. Reference implementations

### 18.1 Graduated vs volume tiers

```ts
export function priceTiers(
  product: Product, qty: bigint, tiers: Tier[], rounding: RoundingConfig
): { extended: Money; trace: TraceEntry[] } {

  const sorted = [...tiers].sort((a, b) => Number(a.fromQty - b.fromQty));

  if (product.tierModel === 'volume') {
    // Land in a tier; ALL units price at that tier's rate.
    // This creates cliffs — see docs/pricing-semantics.md.
    const tier = sorted.filter(t => qty >= t.fromQty).at(-1)!;
    return {
      extended: mulQty(tier.unitPrice, qty),
      trace: [{
        stage: 'tiers', ruleId: tier.id,
        before: mulQty(product.listPrice, qty),
        after: mulQty(tier.unitPrice, qty),
        delta: sub(mulQty(tier.unitPrice, qty), mulQty(product.listPrice, qty)),
        explanation: `volume tier ${tier.fromQty}+ @ ${fmt(tier.unitPrice)}/unit`,
        inputs: { model: 'volume', qty: qty.toString() },
      }],
    };
  }

  // Graduated: each band prices its own units, like tax brackets. Monotonic.
  let remaining = qty;
  let total = ZERO;
  const trace: TraceEntry[] = [];

  for (const [i, tier] of sorted.entries()) {
    if (remaining <= 0n) break;
    const upper = sorted[i + 1]?.fromQty ?? (qty + 1n);
    const band = min(remaining, upper - tier.fromQty);
    const bandTotal = mulQty(tier.unitPrice, band);
    total = add(total, bandTotal);
    remaining -= band;
    trace.push({
      stage: 'tiers', ruleId: tier.id,
      before: total, after: add(total, bandTotal), delta: bandTotal,
      explanation: `${band} units in tier ${tier.fromQty}+ @ ${fmt(tier.unitPrice)}`,
      inputs: { model: 'graduated', band: band.toString() },
    });
  }
  return { extended: total, trace };
}
```

### 18.2 The condition evaluator

```ts
type Condition =
  | { op: 'and'; terms: Condition[] }
  | { op: 'or'; terms: Condition[] }
  | { op: 'not'; term: Condition }
  | { op: 'gte' | 'gt' | 'lte' | 'lt' | 'eq'; field: FieldRef; value: Literal }
  | { op: 'in'; field: FieldRef; values: Literal[] };

/** Constrained evaluation over a known field set. No eval, no user code,
 *  statically analyzable at publish time. */
export function evaluate(c: Condition, ctx: EvalContext): boolean {
  switch (c.op) {
    case 'and': return c.terms.every(t => evaluate(t, ctx));
    case 'or':  return c.terms.some(t => evaluate(t, ctx));
    case 'not': return !evaluate(c.term, ctx);
    case 'in':  return c.values.some(v => eq(resolve(c.field, ctx), v));
    default:    return compare(c.op, resolve(c.field, ctx), c.value);
  }
}

/** Static validation at publish time — catches typo'd fields and type
 *  mismatches before a rule can affect a real quote. */
export function validateCondition(c: Condition, schema: FieldSchema): ValidationError[] {
  // walk the tree, check every FieldRef exists and every comparison typechecks
}
```

---

## 19. Stretch goals

| Feature | Effort | Value |
|---|---|---|
| **Amendments and co-terming** | Large | The most-requested missing feature, and the biggest combinatorial jump. Plan it as v2, not a stretch. |
| **Renewals with uplift** | Medium | Auto-generate renewal quotes with contractual uplift applied |
| **Ramp deals** | Medium | Different quantities per year within one contract |
| **Multi-currency with FX pinning** | Medium | Decide rate-as-of-quote vs rate-as-of-signature; a real financial exposure decision |
| **Usage-based pricing** | Large | Needs a metering integration and a different pricing model |
| **Approval analytics** | Small | Cycle time by approver, bottleneck identification. Cheap and immediately useful. |
| **Discount analytics** | Small | Realized discount by rep, product, segment — feeds directly into rule tuning |
| **Guided selling** | Medium | Question flow → recommended configuration |
| **Proposal engagement tracking** | Small | Which pages did the customer read, for how long. Easy with most e-sign providers. |
| **Quote comparison view** | Small | Side-by-side of two versions, with a diff of what changed |
| **CLM / clause library** | Large | A separate product |

---

## 20. References

### Standards and regulation

| Source | For |
|---|---|
| **ASC 606 / IFRS 15** | Why §11 needs SSP and service dates. You don't implement it; you enable it. |
| **ESIGN Act (US), UETA, eIDAS (EU)** | What makes an e-signature enforceable: intent, consent to electronic records, record retention, association of signature with record. Your provider handles this — don't break it by losing the certificate. |
| **ISO 4217** | Currency codes and minor-unit exponents (not every currency is 2 decimals) |
| **PDF/A** | If long-term archival of executed contracts matters |

That ISO 4217 point is worth noting even in a single-currency v1: JPY has zero minor units, KWD has three. Code that assumes "cents" breaks the day someone sells in Tokyo.

### Technical

- **Martin Fowler**, "Money" pattern (*Patterns of Enterprise Application Architecture*) — the case for a Money type
- **`dinero.js` / `decimal.js`** — read the docs on rounding modes even if you implement your own
- **CSS Paged Media specification** — page breaks, margin boxes, running headers
- **DocuSign eSignature REST API** and **Dropbox Sign API** — envelope lifecycle, webhook verification, anchor tagging
- **Avalara AvaTax** / **Stripe Tax** API docs — the tax integration you should be doing instead of building
- **fast-check** — property testing in TypeScript

### Domain

- Published analyses of CPQ implementation failure rates and their causes — the ~32% success figure, the 67% reconfiguration rate, and the "pricing waterfall rules and bundle structure, traced back to no named governance owner" diagnosis
- Salesforce's End-of-Sale announcement for CPQ (March 2025) and the Revenue Cloud Advanced migration material — useful for understanding what the category-defining product got wrong enough to rebuild
- Vendor write-ups on the CPQ-to-billing gap — the source of §11

---

## Appendix A — Decision record

| Decision | Rationale |
|---|---|
| **Write pricing semantics before code, signed by finance** | Stacking mode, rounding points, and tier models are business decisions with permanent consequences. Discovering a mismatch in month four means re-pricing everything. |
| **Quotes are immutable; reads never reprice** | A quote is a commercial artifact. If rules change, last month's quote must still show what the customer received. Retrofitting this is a rewrite. |
| Rule sets versioned and immutable; quotes pin a version | The only way reproduction is possible |
| Replay regression over all historical quotes in CI | Turns "can we still reproduce that contract?" from an audit surprise into a build failure |
| **Integer minor units with branded types; never floats** | `0.1 + 0.2 !== 0.3` is not acceptable on a contract. The brand makes the mistake a compile error. |
| Rates as basis points | Keeps the entire pipeline in exact integer arithmetic until a deliberate rounding step |
| Explicit rounding mode at every call site | No library default silently disagreeing with what finance specified |
| Currency on every amount, even in single-currency v1 | ISO 4217 minor units vary (JPY 0, KWD 3); the compiler finds every site the day a second currency arrives |
| Pricing engine is pure — no clock, no I/O, no random | Makes replay possible and the engine trivially testable |
| Stable tiebreak on equal rule priority | Without it the engine is nondeterministic, and with floors the order changes the result |
| **Price trace built from the first stage** | The audit artifact, the deal-desk tool, and the debugger. Retrofitting means threading context through everything. |
| Rules are constrained data, not a scripting language | A rule engine that runs user-supplied JS is an RCE vector with a friendly UI |
| Tier model explicit per product; cliffs allowlisted | Volume tiers make 101 units cheaper than 100. Sometimes intended, never accidental. |
| Floors clamp-and-warn, surfaced in the UI | Silent clamping makes reps distrust the system and go to Excel |
| **Approval fingerprint over material terms only** | Closes the edit-after-approval hole without voiding a CFO's approval over a typo fix |
| Rule changes get their own approval flow with mandatory simulation | User-editable pricing rules are user-editable revenue. "This would have cost $340k on the last 200 deals" makes review a measurement. |
| Deterministic PDF output, asserted byte-identical in CI | You are going to hash this document; nondeterminism breaks the integrity check |
| Templates versioned like rule sets | "Regenerate last quarter's PDF" must produce the same document |
| E-sign anchor-text positioning, not coordinates | A product name wrapping to two lines shifts the layout and misplaces the signature field |
| **Webhooks plus polling reconciliation** | Webhooks get dropped. A contract signed days ago still showing "sent" is how you find out. |
| Idempotency key from content hash, stored before the call | A retry must not create a second contract |
| Verify the signed document matches the generated one | The integrity check that makes the audit trail meaningful |
| Store the completion certificate permanently | It's what gives the signature legal weight under ESIGN and eIDAS |
| **Structured `ExecutedContract` output with SSP and service dates** | "CPQ output can't be ingested by billing" is a documented recurring failure. PDF-only means manual re-keying everywhere. |
| Never build tax | Thousands of jurisdictions, changing monthly. Avalara or Stripe Tax. |
| Amendments, renewals, ramps, multi-currency out of v1 | Where CPQ combinatorics explode and 18-month implementations come from |
| **A sanctioned non-standard deal path** | Shadow CPQ happens anyway. Sanctioned means it stays visible, and its frequency measures where the rule model is inadequate. |
| No `UPDATE` on quote data; events are append-only | The event log is the audit trail, and derived state is a consistency check |

---

## Appendix B — Quick reference card

```
BEFORE ANY CODE — decide and get signed off
  stacking      additive 20+15 = 35%  │  multiplicative = 32%
                $3,000 difference on $100k
  rounding      round-then-multiply vs multiply-then-round
                $10.005 × 1000 → $10,010.00 or $10,005.00
  tier model    graduated (brackets, monotonic)
                volume (land-in-tier, CREATES CLIFFS)
                101 units @ volume can cost less than 100
  precision     totals scale 2; unit prices scale 6
  floors        clamp-and-warn, surfaced in the UI

MONEY
  bigint minor units, branded type, no arithmetic operators exposed
  rates as basis points (15% = 1500n)
  explicit rounding mode at EVERY call site
  currency on every amount (JPY=0, KWD=3 minor units)

IMMUTABILITY
  rule_sets      versioned, immutable once published
  quote_versions pin rule_set_version + price_book_version
  getQuote()     returns materialized — NEVER calls the engine
  reprice()      explicit, creates a NEW version
  CI test        replay every historical quote, assert unchanged

PRICING PIPELINE (ordered, pure, traced)
  configure → base → tiers → discounts → floors → round
  → line totals → order level → tax(delegate) → materialize
  no Date.now() · no I/O · no random · stable sort before iterating
  tiebreak equal priority by id, or it isn't deterministic

APPROVALS
  fingerprint = sha256 over MATERIAL terms only
    in:  lines, qty, unit price, discount, total, terms, dates
    out: cover letter, formatting, cosmetic fields
  every approval records the fingerprint it approved
  send() refuses if fingerprint ≠ current, and names who must re-approve
  escalate on BUSINESS hours, not wall clock

E-SIGN
  idempotency key = sha256(quoteId:version:documentHash), stored first
  webhooks (HMAC + replay window) AND polling every 15 min
  log reconciliation drift — it means webhooks are broken
  verify signed doc matches generated doc
  store the completion certificate forever (ESIGN / eIDAS)

DOWNSTREAM — the fields everyone forgets
  billingFrequency · recognitionMethod
  standaloneSellingPrice (ASC 606) · service start/end per line

GOVERNANCE
  rules = data, editable without a deploy
  rule changes need approval + mandatory simulation on last 200 quotes
  show newly-requires-approval count, not just revenue delta
  sanctioned non-standard path → always top-tier approval, always flagged
  rising non-standard rate = where the rule model is inadequate
```
