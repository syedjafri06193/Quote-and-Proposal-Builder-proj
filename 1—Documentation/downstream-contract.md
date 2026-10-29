# Downstream contract schema (`contract.executed`)

**Status:** v1.0 — **needs review by billing** before M8 is done (design guide §17: "someone from
billing has looked at the schema and confirmed they could ingest it").

When a signed document is verified against the generated one, the system stores the executed PDF
and completion certificate and publishes one `contract.executed` event per contract:

- **Topic:** `contract.executed`
- **Idempotency key:** `contract-executed:<contractId>` — redelivery is safe; dedupe on it.
- **Delivery:** outbox (append-only); replaying the outbox rebuilds any consumer.

## Payload

```jsonc
{
  "contract": {
    "schemaVersion": "1.0",
    "contractId": "ctr-1001-v3",
    "quoteId": "q-1", "quoteNumber": 1001, "quoteVersion": 3,
    "documentHash": "<sha256 of the generated PDF>",
    "contentHash": "<sha256 of the render model; embedded in the PDF>",
    "executedAt": "2026-10-05T16:15:00.000Z",
    "currency": "USD",
    "customer": { "accountId": "…", "name": "…", "billingAddress": { … }, "taxIds": [ … ] },
    "term": { "startDate": "2026-11-01", "endDate": "2029-10-31", "months": 36, "autoRenew": true, "noticePeriodDays": 30 },
    "lines": [{
      "lineId": "L1", "productId": "plat", "sku": "PLT-SEAT", "description": "…",
      "quantity": "250",                       // strings: exact integers
      "unitPriceMinorUnits": "164894520",      // at unitPriceScale (6): $164.894520 per unit per year
      "unitPriceScale": 6,
      "extendedMinorUnits": "12367089",        // at minorUnitScale (2): $123,670.89 for the whole term
      "discountBasisPoints": 3129,
      "billingFrequency": "annual",            // monthly | quarterly | annual | one-time
      "recognitionMethod": "ratable",          // ratable | point-in-time
      "standaloneSellingPriceMinorUnits": "17100000",  // SSP for the whole line, for ASC 606 allocation
      "serviceStartDate": "2026-11-01",
      "serviceEndDate": "2029-10-31"
    }],
    "paymentTerms": { "netDays": 30, "method": "ACH" },
    "totalMinorUnits": "16508039", "totalDecimal": "165080.39", "minorUnitScale": 2,
    "ruleSetVersion": 1, "priceBookVersion": 1,
    "nonStandard": false,
    "approvals": [{ "approverId": "mike", "role": "manager", "decision": "approved", "conditions": null, "decidedAt": "…" }]
  }
}
```

## Guarantees

- `sum(lines[].extendedMinorUnits) == totalMinorUnits` exactly.
- Amounts exclude tax.
- `extendedMinorUnits` is the amount for the **whole term** of the line, not per year.
- The fields billing and rev-rec most often lack are always present: **billing frequency,
  recognition method, standalone selling price, per-line service dates.**
- `validateExecutedContract()` in `src/contracts/contract.ts` is the reference validator.
