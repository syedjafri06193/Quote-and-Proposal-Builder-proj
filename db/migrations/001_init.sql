-- Quote & Proposal Builder — PostgreSQL schema (design guide §14).
--
-- The running reference build uses an in-process append-only store with the
-- same shapes (src/store/store.ts). This migration is the target schema for a
-- Postgres-backed implementation of that interface.
--
-- Rule: no UPDATE on quote data. New versions, new events. The only mutable
-- columns are quotes.state and envelopes.state, both reconstructable from
-- their event logs.

CREATE TABLE users (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    email       TEXT NOT NULL,
    roles       TEXT[] NOT NULL,
    manager_id  TEXT REFERENCES users(id)
);

CREATE TABLE accounts (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    segment         TEXT NOT NULL,
    billing_address JSONB NOT NULL,
    tax_ids         JSONB NOT NULL DEFAULT '[]',
    signer          JSONB NOT NULL
);

-- Catalog and rules: versioned, immutable once published
CREATE TABLE price_books (
    version       INT PRIMARY KEY,
    currency      CHAR(3) NOT NULL,
    published_at  TIMESTAMPTZ NOT NULL,
    entries       JSONB NOT NULL          -- product snapshot incl. list price, SSP, billing, recognition
);

CREATE TABLE rule_sets (
    version         INT PRIMARY KEY,
    definition      JSONB NOT NULL,
    content_hash    TEXT NOT NULL,
    effective_from  TIMESTAMPTZ NOT NULL,
    published_at    TIMESTAMPTZ NOT NULL,
    published_by    TEXT NOT NULL REFERENCES users(id),
    approved_by     TEXT NOT NULL REFERENCES users(id),
    draft_id        TEXT,
    notes           TEXT NOT NULL DEFAULT '',
    CHECK (approved_by <> published_by)
);

CREATE TABLE rule_drafts (
    id                TEXT PRIMARY KEY,
    title             TEXT NOT NULL,
    based_on_version  INT NOT NULL REFERENCES rule_sets(version),
    definition        JSONB NOT NULL,
    effective_from    TEXT NOT NULL,        -- 'on-publish' or ISO timestamp
    author            TEXT NOT NULL REFERENCES users(id),
    state             TEXT NOT NULL CHECK (state IN ('DRAFT','SIMULATED','PENDING_APPROVAL','PUBLISHED','REJECTED')),
    simulation        JSONB,
    simulated_hash    TEXT,
    published_version INT REFERENCES rule_sets(version),
    history           JSONB NOT NULL DEFAULT '[]',
    created_at        TIMESTAMPTZ NOT NULL,
    updated_at        TIMESTAMPTZ NOT NULL
);

CREATE TABLE templates (
    version       INT PRIMARY KEY,
    name          TEXT NOT NULL,
    published_at  TIMESTAMPTZ NOT NULL,
    body          JSONB NOT NULL
);

-- Quotes: append-only versions
CREATE TABLE quotes (
    id            TEXT PRIMARY KEY,
    number        INT NOT NULL UNIQUE,
    account_id    TEXT NOT NULL REFERENCES accounts(id),
    owner_id      TEXT NOT NULL REFERENCES users(id),
    state         TEXT NOT NULL,        -- denormalized; must equal the fold of quote_events
    non_standard  BOOLEAN NOT NULL,     -- permanent flag
    created_at    TIMESTAMPTZ NOT NULL
);

CREATE TABLE quote_versions (
    quote_id             TEXT NOT NULL REFERENCES quotes(id),
    version              INT NOT NULL,
    config               JSONB NOT NULL,     -- the input
    materialized         JSONB NOT NULL,     -- the priced output, trace included
    rule_set_version     INT NOT NULL REFERENCES rule_sets(version),
    price_book_version   INT NOT NULL REFERENCES price_books(version),
    approval_fingerprint TEXT NOT NULL,
    content_hash         TEXT NOT NULL,
    priced_at            TIMESTAMPTZ NOT NULL,
    created_by           TEXT NOT NULL REFERENCES users(id),
    PRIMARY KEY (quote_id, version)
);

-- Everything that happens is an event, never an UPDATE
CREATE TABLE quote_events (
    id            BIGSERIAL PRIMARY KEY,
    quote_id      TEXT NOT NULL REFERENCES quotes(id),
    quote_version INT,
    type          TEXT NOT NULL,
    actor         TEXT NOT NULL,
    payload       JSONB NOT NULL,
    occurred_at   TIMESTAMPTZ NOT NULL
);
CREATE INDEX quote_events_quote ON quote_events (quote_id, id);

CREATE TABLE approval_plans (
    id            TEXT PRIMARY KEY,
    quote_id      TEXT NOT NULL REFERENCES quotes(id),
    quote_version INT NOT NULL,
    plan          JSONB NOT NULL,        -- stored: in-flight approvals follow the plan they started with
    submitted_at  TIMESTAMPTZ NOT NULL,
    submitted_by  TEXT NOT NULL,
    rep_note      TEXT NOT NULL DEFAULT ''
);

CREATE TABLE approvals (
    id            TEXT PRIMARY KEY,
    quote_id      TEXT NOT NULL REFERENCES quotes(id),
    quote_version INT NOT NULL,
    plan_id       TEXT NOT NULL REFERENCES approval_plans(id),
    slot_id       TEXT NOT NULL,
    slot_key      TEXT NOT NULL,
    approver_id   TEXT NOT NULL REFERENCES users(id),
    on_behalf_of  TEXT REFERENCES users(id),
    role          TEXT NOT NULL,
    fingerprint   TEXT NOT NULL,         -- ★ what they actually approved
    decision      TEXT NOT NULL CHECK (decision IN ('approved','rejected','conditional')),
    conditions    TEXT,
    comment       TEXT,
    decided_at    TIMESTAMPTZ NOT NULL
);

CREATE TABLE delegations (
    id           TEXT PRIMARY KEY,
    from_user_id TEXT NOT NULL REFERENCES users(id),
    to_user_id   TEXT NOT NULL REFERENCES users(id),
    valid_from   TIMESTAMPTZ NOT NULL,
    valid_until  TIMESTAMPTZ NOT NULL,
    reason       TEXT NOT NULL DEFAULT '',
    created_at   TIMESTAMPTZ NOT NULL
);

CREATE TABLE documents (
    id               TEXT PRIMARY KEY,
    quote_id         TEXT NOT NULL REFERENCES quotes(id),
    quote_version    INT NOT NULL,
    template_version INT NOT NULL REFERENCES templates(version),
    sha256           TEXT NOT NULL,
    content_hash     TEXT NOT NULL,
    storage_key      TEXT NOT NULL,
    generated_at     TIMESTAMPTZ NOT NULL,
    FOREIGN KEY (quote_id, quote_version) REFERENCES quote_versions(quote_id, version)
);

CREATE TABLE envelopes (
    id              TEXT PRIMARY KEY,
    quote_id        TEXT NOT NULL REFERENCES quotes(id),
    quote_version   INT NOT NULL,
    document_id     TEXT NOT NULL REFERENCES documents(id),
    provider        TEXT NOT NULL,
    provider_id     TEXT,
    idempotency_key TEXT NOT NULL UNIQUE,     -- written BEFORE calling the provider
    state           TEXT NOT NULL,
    recipients      JSONB NOT NULL,
    applied_event_ids TEXT[] NOT NULL DEFAULT '{}',
    decline_reason  TEXT,
    created_at      TIMESTAMPTZ NOT NULL,
    sent_at         TIMESTAMPTZ,
    completed_at    TIMESTAMPTZ
);

CREATE TABLE envelope_events (
    id          BIGSERIAL PRIMARY KEY,
    envelope_id TEXT NOT NULL REFERENCES envelopes(id),
    source      TEXT NOT NULL CHECK (source IN ('webhook','reconcile','local')),
    from_state  TEXT NOT NULL,
    to_state    TEXT NOT NULL,
    event_id    TEXT NOT NULL,
    drift       BOOLEAN NOT NULL,           -- true = found by polling: a webhook was missed
    at          TIMESTAMPTZ NOT NULL
);

CREATE TABLE executed_contracts (
    contract_id      TEXT PRIMARY KEY,
    quote_id         TEXT NOT NULL UNIQUE REFERENCES quotes(id),
    contract         JSONB NOT NULL,
    signed_doc_key   TEXT NOT NULL,
    certificate_key  TEXT NOT NULL,         -- kept permanently (ESIGN / eIDAS evidence)
    stored_at        TIMESTAMPTZ NOT NULL
);

CREATE TABLE outbox (
    id              BIGSERIAL PRIMARY KEY,
    topic           TEXT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    payload         JSONB NOT NULL,
    published_at    TIMESTAMPTZ NOT NULL
);

CREATE TABLE review_flags (
    id      TEXT PRIMARY KEY,
    kind    TEXT NOT NULL,
    ref     TEXT NOT NULL,
    message TEXT NOT NULL,
    at      TIMESTAMPTZ NOT NULL
);

-- Enforce append-only at the database level for the quote record.
CREATE FUNCTION forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER quote_versions_append_only BEFORE UPDATE OR DELETE ON quote_versions FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER quote_events_append_only   BEFORE UPDATE OR DELETE ON quote_events   FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER approvals_append_only      BEFORE UPDATE OR DELETE ON approvals      FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER rule_sets_append_only      BEFORE UPDATE OR DELETE ON rule_sets      FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER price_books_append_only    BEFORE UPDATE OR DELETE ON price_books    FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER templates_append_only      BEFORE UPDATE OR DELETE ON templates      FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER documents_append_only      BEFORE UPDATE OR DELETE ON documents      FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
