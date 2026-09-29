# Quote-and-Proposal-Builder-proj

CPQ flow with tiered pricing rules, discount approval chains, and templated proposal generation handed off to e-signature.

This is a working TypeScript implementation of the design in
[`Documentation/README.md`](Documentation/README.md): an immutable, versioned quote model; a
deterministic pricing engine with a full price trace; explicit discount stacking and rounding;
approval chains protected by a content fingerprint; deterministic PDF proposals; e-signature with
webhook + polling reconciliation; and a structured contract that billing can ingest.

## Quick start

Requires Node 22+.

```bash
npm install
npm run seed      # optional: a few sample quotes in different states (data/db.json)
npm start         # http://localhost:3000   — quote builder
                  # http://localhost:3000/admin — rules, simulation, governance health
npm test          # 109 tests: money, golden fixtures, properties, cliffs, replay, approvals, PDFs, e-sign, API
npm run typecheck # strict + noUncheckedIndexedAccess + exactOptionalPropertyTypes
npm run demo      # end-to-end walkthrough in the terminal (writes data/demo-proposal.pdf)
```

Use the **Acting as** switcher in the top bar to play each role: reps (Alice, Bob), their manager
(Mike), VP sales (Vera), deal desk (Dana), finance (Fran), legal (Lee), CFO (Carl), the pricing
owner (Priya) and a pricing analyst (Sam). The **Signature** tab drives a built-in fake e-sign
provider (view / sign / decline / expire / tamper, drop webhooks, run reconciliation).

## What's in it

| Design guide | Where | Notes |
|---|---|---|
| §3 / M0 pricing semantics | [`docs/pricing-semantics.md`](docs/pricing-semantics.md) | Multiplicative stacking, half-up rounding once at the line, graduated vs volume tiers, clamp-and-warn floors, N/12 proration. **Needs finance sign-off.** |
| §5 / M1 money | `src/money/money.ts` | Branded `bigint` minor units, 7 explicit rounding modes, basis points, ISO 4217 scales. `Money + number` is a compile error (tested). |
| §4 / M2 immutability | `src/store/store.ts`, `src/app/quotes.ts` | Append-only versions and events; `getQuote` never calls the engine (tested with an engine that throws); `reprice` creates a new version. SQL target schema in `db/migrations/001_init.sql`. |
| §6 / M3 pricing engine | `src/pricing/` | Pure pipeline `configure → base → tiers → discounts → floors → round → order-level → tax(delegated)`, every stage traced. Constrained condition language, validated at publish. |
| §12 / M4 rule governance | `src/app/rules.ts`, `src/rules/` | DRAFT → SIMULATED → PENDING_APPROVAL → PUBLISHED; mandatory simulation against recent quotes (revenue delta + approval-load change); author ≠ approver; id-keyed diff; effective dating, no retroactive changes. |
| §8 / M5 approvals | `src/approvals/` | Plan resolution (sequential/parallel, role / user / manager-of), stored plan, **fingerprint over material terms only**, delegation, business-hours escalation, approve-with-conditions, recall, owner can't self-approve. |
| §9 / M6 documents | `src/documents/generate.ts` | pdf-lib with standard fonts and fixed metadata → byte-identical output (tested). Repeating table headers, rows never split, conditional SLA appendix, anchor-text signature fields, versioned templates. |
| §10 / M7 e-signature | `src/esign/` | Provider interface, `FakeESignProvider` (every state), `DocuSignProvider` adapter; idempotency key stored before the call, crash recovery, HMAC + replay-window webhooks, polling reconciliation with drift logging, signed-document integrity check, certificate stored. |
| §11 / M8 contract | `src/contracts/contract.ts`, [`docs/downstream-contract.md`](docs/downstream-contract.md) | `ExecutedContract` with billing frequency, recognition method, SSP and per-line service dates; published once to an idempotent outbox. |
| M9 builder UI | `public/` | Quote builder, price-trace waterfall, approvals, inbox + delegation, PDF preview, signature simulator, contract, audit log. No build step. |
| §12.4 / M10 governance | `/admin#/health` | Sanctioned non-standard quotes (manual prices, always top-tier approval, permanent flag, frequency report), replay check, state/event-log consistency, review flags, outbox, audit export. |

## Repository layout

```
src/
  money/        exact arithmetic (no dependencies)
  pricing/      pure engine: pipeline, stages/, conditions, trace, codec
  approvals/    plan resolution, fingerprint, business hours, state machine
  rules/        validation, simulation, diff
  documents/    deterministic proposal PDF
  esign/        provider interface, fake provider, DocuSign adapter
  contracts/    ExecutedContract builder + validator
  store/        append-only store (in-memory / JSON file)
  app/          services: quotes, rules, composition root
  api/          HTTP API + static UI server
  seed/         catalog, rule set v1, users, accounts
public/         builder + admin UI (vanilla JS)
tests/          vitest + fast-check; golden/ fixtures are hand-computed
docs/           pricing semantics, rule authoring, downstream contract
db/migrations/  PostgreSQL target schema
scripts/        demo, seed
```

`src/pricing` imports nothing that touches the clock, randomness, network or filesystem — a test
enforces it. That's what makes the replay test possible: every stored quote version is re-priced
under its pinned rule set and price book and must reproduce byte-for-byte.

## Known limits of this build

- **Auth is a stub.** The acting user comes from the `X-User` header. Put OIDC/SAML in front before real use.
- **Storage** is an in-process append-only store persisted to `data/db.json`, fine for a single
  instance. The Postgres schema (with append-only triggers) is in `db/migrations/`; porting the
  `Store` class to it is mechanical.
- **E-signature** defaults to the fake provider, which keeps envelopes in memory: envelopes sent
  before a server restart can't be driven from the Signature tab afterwards. The DocuSign adapter
  follows the public REST v2.1 docs but has not been exercised against a sandbox account.
- **Pending human sign-offs** the design guide calls for: finance on `docs/pricing-semantics.md`
  (M0) and billing on `docs/downstream-contract.md` (M8).
- Out of v1 scope by design: amendments/renewals/co-terming, ramps, multi-currency, usage pricing,
  tax calculation (delegated), CLM.
