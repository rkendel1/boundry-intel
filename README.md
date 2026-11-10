# Boundry Intel

The Boundry ecosystem registry: stable identities for products, product versions, GitHub repositories, capabilities
and integrations, the explicit relationships between them, and the provenance of every statement, stored on FeltDB
as **attributable references and observations**; the authenticated publisher identities that may speak to it; and
durable acceptance of the `boundry.event/1` envelopes those publishers report. It is the foundation future
integrations and dashboards read from. It is not a deployment, a sync job or a dashboard (see "Not in scope").

`@boundry/intel-registry` 0.1.0 (private). Plain Node ESM, no build step, no LLM anywhere.

## Architectural rules

These are the rules the registry is built to, and the ones a change must not break.

| Rule | How the registry keeps it |
|---|---|
| **GitHub remains authoritative for GitHub activity.** | A `repository` record is a *reference* (`provenance.kind: "reference"`, `source.system: "github"`, a locator into GitHub). The registry stores identity and a pointer, never commits, issues or activity. |
| **Product repositories remain authoritative for their code and releases.** | A `product-version` and its `released-from` relationship carry the tag, commit and release URL as a reference into the repository. No changelog, artifact or code is copied. |
| **Boundry Intel stores attributable references and observations, not duplicate copies.** | Every record has `provenance`: `kind` (`reference` to an authority or `observation` by Boundry), `source` (system and locator), `assertedBy` (who or what), `observedAt` (the source's time) and `recordedAt` (the registry's clock, set by the store). Documents are closed (unknown members refused) and at most 16 KiB, so there is no room for a copy of anything. |
| **FeltDB remains the durable state foundation.** | One FeltDB application state contract (`BOUNDRY_INTEL_CONTRACT`) over every collection this system owns, generic primitives only: transactions, `requireAbsent`, `expectedVersion`, a unique constraint, reference fields, equality indexes. No FeltDB code is changed; no second database exists. |
| **Dashboards are projections, never authorities.** | `src/projections.mjs` is read-only and deterministic: the same registry state gives the same projection. A projection carries each record's provenance so a dashboard can show *where a fact came from* and link back to the authority. |
| **No new control plane or database.** | The store takes a `StateFirstDB` from `@feltdb/core`; tests use `createFeltDB({ mode: "local" })` in a temporary directory. Which FeltDB authority hosts it later is the owner's open question Q1 (see `docs/intelligence-evaluation.md`); nothing here assumes an answer. |
| **Useful without an LLM.** | Validation, identity, storage and every query are deterministic functions. There is no inference, ranking, summarisation or model call in this package, and its dependencies carry none into the registry path. |
| **Acceptance is separate from interpretation.** | An accepted event is stored verbatim beside its digest and the members needed to find it again. No attribution, identity class, confidence or counter is derived on the write path, so an interpretation that changes never requires rewriting an immutable record of what was reported. |
| **Reuse before invention.** | The event contract, the publisher key format and the acceptance semantics are migrated from `rkendel1/boundry` rather than rewritten; product and event id grammars are `boundry.event/1`'s; `provides.mechanism` is `appport.feedback/1`'s integration-mechanism vocabulary; digests and the credential floor are `@appport/protocol`'s; the FeltDB contract pattern is the one `FeltDbFeedbackStore` and the old event store use. |

## The contract: `boundry.registry/1`

Normative schema: [`schema/boundry-registry-1.schema.json`](schema/boundry-registry-1.schema.json). Reference
validator: `validateDocument` in [`src/contract.mjs`](src/contract.mjs). A test proves they agree on every valid
form and on every refusal the schema can express; the rules only the validator can express (derived ids, relationship
endpoint kinds, reflexivity, the credential floor, the future bound on `observedAt`) are listed in that test.

### Documents

Every document is `{ schema: "boundry.registry/1", kind, ...members, provenance }`. `id` is **derived** from the
document's natural key; a document may carry it, and then it must match.

| `kind` | Members (required in bold) | Derived `id` |
|---|---|---|
| `product` | **`productId`** (`^[a-z][a-z0-9-]{1,63}$`), **`name`**, `summary`, `category`, `homepage` (https), `status` (`planned` `in-development` `preview` `available` `deprecated` `retired`) | `product:<productId>` |
| `product-version` | **`productId`**, **`version`**, `releasedAt`, `channel` (`release` `prerelease`), `packages[]` (`{ registry: "npm", name, version }`, 1–20) | `product-version:<productId>@<version>` |
| `repository` | **`host`** (`github.com`), **`owner`**, **`name`**, `defaultBranch`, `visibility` (`public` `private`), `archived` | `repository:<host>/<owner>/<name>` |
| `capability` | **`name`** (dotted, e.g. `invoices.create`), `version` (integer ≥ 1), `summary` | `capability:<name>` or `capability:<name>@<version>` |
| `integration` | **`integrationId`** (slug), **`name`**, **`integrationKind`** (`github-app` `webhook` `service` `agent` `dashboard` `operator` `other`), **`boundary`** `{ mode: read \| write \| read-write, scopes[1..32], note? }`, `principal` `{ type: user \| service \| device \| application, id }`, `contact` | `integration:<integrationId>` |
| `relationship` | **`type`**, **`from`**, **`to`**, `attributes` (per type, below) | `relationship:<type>:<16 hex of sha256([from, to])>` |

An integration's **authorization boundary** is the `boundary` member (what kind of access, which scopes) plus its
`authorized-for` relationships (which registry things). A `principal` is an identity reference, never a credential:
every string in every document passes the credential floor (`detectSensitive`) and a document that looks like it
carries a secret is refused without echoing it.

### Relationships

| `type` | `from` → `to` | `attributes` |
|---|---|---|
| `repository-of` | `repository` → `product` | `role`: `primary` `documentation` `examples` `mirror` |
| `released-from` | `product-version` → `repository` | **`tag`**, `commit` (hex 7–64), `url` (https) |
| `provides` | `product` or `product-version` → `capability` | `mechanism`: `appport` `http` `sdk` `mcp` `cli` `other` (`appport.feedback/1`) |
| `authorized-for` | `integration` → `product`, `capability` or `repository` | `mode`: `read` `write` `read-write` |
| `evidenced-by` | any entity → `event:<productId>:<eventId>` | `eventType` (dotted; vocabulary is `boundry.event/1`'s), `occurredAt` |
| `depends-on` | `product` or `product-version` → `product` or `product-version` | `scope`: `runtime` `build` `peer` `optional` |
| `component-of` | `product` → `product` | — |
| `registered-with` | `product` or `repository` → `integration` | **`status`** (`pending` `verified` `failed` `revoked`), `method` (`github-app` `publisher-key` `manifest` `operator`), `lastVerifiedAt`, `publisher` (12 hex) |

`RELATIONSHIP_TYPES` is closed: these eight and no others. `from` and `to` must be recorded (the store refuses a
dangling relationship, and FeltDB refuses deleting an entity a relationship still names). An **event reference** `event:<productId>:<eventId>` is the `boundry.event/1` identity
`(product.id, id)`; the registry never stores an event, only this pointer and, optionally, its type and time.

### Provenance

```json
"provenance": {
  "kind": "reference",
  "source": { "system": "github", "locator": "https://github.com/rkendel1/flow_db" },
  "assertedBy": { "type": "integration", "id": "repo-sync" },
  "observedAt": "2026-11-09T10:00:00Z"
}
```

| Member | Values | Rule |
|---|---|---|
| `kind` | `reference`, `observation` | a reference points at an authority and **must** name `source.locator`; an observation is Boundry's own record |
| `source.system` | authorities: `github` `npm` `product-repository` `product-manifest`; observers: `boundry.event` `operator` `integration` | a `reference` may only name an authority |
| `source.locator` | ≤ 512 chars | where in the source (URL, release tag, manifest path) |
| `assertedBy` | `{ type: operator \| integration \| product \| job, id }` | who or what made the statement |
| `observedAt` | RFC 3339 | the source's time; at most 300 s in the future |
| `recordedAt` | RFC 3339 | **set by the store**; refused on input |

Provenance is part of the assertion: the same content with different provenance is a different assertion (a
`conflict` on re-assertion, resolved by `revise`).

## Store

```js
import { createFeltDB } from '@feltdb/core';
import { prepare, RegistryStore, productProjection } from '@boundry/intel-registry';

const db = createFeltDB({ mode: 'local', namespace: 'boundry-intel-registry', path: './data', access: 'shared' });
await prepare(db);                                     // installs BOUNDRY_INTEL_CONTRACT once (stateContract.evolve)
const registry = new RegistryStore(db);

const r = await registry.assert({ schema: 'boundry.registry/1', kind: 'product', productId: 'feltdb', name: 'FeltDB', provenance });
// r.status: 'recorded' | 'unchanged' | 'conflict' | 'rejected'
```

| Operation | Semantics |
|---|---|
| `assert(document)` | once, under the derived id, with `requireAbsent`. `recorded` (committed before returning), `unchanged` (same digest; idempotent), `conflict` (same id, different content; nothing written; `current` returned), `rejected` (invalid or dangling; `issues`). |
| `revise(document, { expectedDigest })` | compare-and-set replacement. `revised`, `unchanged`, `conflict` (`registry.digest.stale`), `missing`, `rejected`. The superseded document is appended to `registry_revisions` in the same transaction. |
| `assertAll(documents)` | in order; one result each. |
| `get(id)` · `list({ kind, productId, relationshipType, fromId, toId })` · `relationships({ from, to, type })` · `history(id)` | reads; sorted by id; bounded. `history` returns every revision, superseded and current. |

FeltDB collections: `registry_records` (one per registry id; unique on `registryId`; indexes on kind, product,
relationship type, from, to; `fromKey`/`toKey` are reference fields) and `registry_revisions` (append-only). FeltDB
record ids are digests of the registry id (`reg_<hex>`) because FeltDB ids cannot carry `:`, `/` or `@`; the readable
id is the unique field. The digest of a document is RFC 8785 canonical JSON + SHA-256 over the assertion (everything
but `recordedAt`).

## One application contract

The registry, the publisher directory and the event store are not three FeltDB contracts. FeltDB governs a store with
exactly one application contract — evolving a second is refused, and writing a collection the active contract does not
declare is refused too, both verified against the local runtime in `test/integration.test.mjs`. So each module
declares the fields and indexes of its own collections and `src/application.mjs` composes them into one:

| Collections | Module | Holds |
|---|---|---|
| `registry_records`, `registry_revisions` | `store.mjs` | `boundry.registry/1` documents and their history |
| `intel_publishers` | `publishers.mjs` | publisher identities (the key's hash only, never the key) |
| `intel_events` | `acceptance.mjs` | accepted `boundry.event/1` envelopes, verbatim |

`prepare(db)` installs it once and answers whether it did. `RegistryStore.prepare`, `PublisherDirectory.prepare` and
`EventAcceptor.prepare` all delegate to it, so there is one way to install and one source of truth for what the
authority enforces.

## Publishers and event acceptance

Full contract: [`docs/integration-contracts.md`](docs/integration-contracts.md).

A **publisher** is an authenticated identity bound to exactly one subject — one `product:<id>` or one
`repository:<host>/<owner>/<name>` — with a closed set of scopes (`events:write`, `registry:assert`,
`registration:verify`). The key (`bik_<12 hex>_<43 base64url>`) is returned once at issue and stored only as a
SHA-256 hash, compared in constant time. The subject binding is the isolation boundary and is checked on every call:
`authorizes(publisher, { scope, subject, productId })` is pure, and authority is never inherited through a registry
relationship.

```js
const publishers = new PublisherDirectory(db);
const { publisher, key } = await publishers.issue({ subject: 'product:feltdb', name: 'FeltDB emitter', scopes: ['events:write'], createdBy: 'operator:randy' });

const events = new EventAcceptor(db, publishers);
const [answer] = await events.accept(key, [envelope]);
// answer.status: 'accepted' | 'duplicate' | 'conflict' | 'rejected' | 'unauthorized'
```

| Answer | Meaning | Retry |
|---|---|---|
| `accepted` | validated, authorized and committed before the call returned | no |
| `duplicate` | that identity is stored with the same canonical digest: an idempotent resend | no |
| `conflict` | that identity is stored with different content; nothing written | never |
| `rejected` | invalid under `boundry.event/1`; nothing written; `issues` say what | never |
| `unauthorized` | unknown or revoked key, missing scope, or another product's event | never |

A refusal writes nothing at all, so being wrong cannot grow the store. Identity is `(product.id, id)` — the same pair
as the registry's `event:<productId>:<eventId>` reference — so a resend after a storage failure is safe.

That a subject registered is recorded in the registry as a `registered-with` relationship to an `integration`
(`status`: `pending` `verified` `failed` `revoked`), not as a document kind, so FeltDB refuses a dangling registration
and `registry_revisions` supplies the status history. The credential stays out of the registry entirely.

### The AppPort feedback bridge

[`src/appport-feedback.mjs`](src/appport-feedback.mjs). AppPort Services stays authoritative for feedback records and
their lifecycle; this maps an `appport.feedback/1` lifecycle change to a `boundry.event/1` envelope, so a provider can
forward **evidence that a change happened** without this system recreating its records.

```js
import { createFeedbackForwarder } from '@appport/sdk';
import { feedbackMapping } from '@boundry/intel-registry';

const forwarder = createFeedbackForwarder({ map: feedbackMapping({ id: 'appport-services', version: '0.16.0' }), transport });
const feedback = createFeedbackProvider({ /* … */, observe: forwarder.observe });
```

| | |
|---|---|
| A submission | `feedback.submitted` with the feedback id, category, severity and the report's fingerprint |
| A transition | `feedback.updated` with the id, `from`, `to` and the sequence |
| A terminal state | a `feedback.updated` like any other: `appport.feedback/1` already says which states are terminal |
| Identity | `feedback.<feedbackId>.<sequence>`, so a retry or a replay is a `duplicate`, never a second record |
| Timestamps | the product's own: the receipt's `receivedAt`, the update's `at`. Never the mapping's clock |
| Provenance | each disclosure relayed with its own status; the principal `verified` because the provider authenticated it, the agent `asserted` because it is the reporter's claim about itself |
| Not carried | the summary, expected, observed, reproduction steps and evidence. Evidence of a change, never its content |

The mapping lives here rather than in AppPort because the envelope belongs to `boundry.event/1`, which is defined,
validated and accepted here: every envelope is checked by the real validator and handed to the real acceptor in
`test/appport-feedback.test.mjs`. AppPort supplies the product-neutral half — an observation seam and a forwarder that
takes an injected mapping and transport — and so stays independent of the systems built on it. The direction of
dependency is unchanged: AppPort does not depend on this repository, and this repository already depends on
`@appport/protocol` for the vocabulary `boundry.event/1` imports.

`acceptorTransport(acceptor, key)` hands envelopes straight to an `EventAcceptor` for a process that holds both, so a
test or an operator's script needs no network and implies no deployment.

### The isolation that is enforced

| Boundary | Enforced | How |
|---|---|---|
| Publisher | yes | the key's own subject binding, checked on every accept, never against what an envelope claims |
| Application / namespace | yes | one contract per store; a foreign contract and an undeclared collection are both refused |
| Per-tenant partitioning inside one application | **no** | not implemented; separate FeltDB namespaces are the only tenant boundary today |

## Projections (for dashboards)

`productProjection(store, productId)`, `repositoryProjection(store, id)`, `capabilityProjection(store, id)`,
`integrationProjection(store, id)`, `journey(store, id, { maxDepth, limit })` (the connected neighbourhood across
relationships in both directions, breadth first, event references as leaves) and `snapshot(store)` (every current
record, sorted, with counts by kind and by provenance kind). All read-only, all deterministic, all carrying provenance.

## Development

```bash
npm ci
npm test        # node --test on a real local FeltDB (temporary directory, enforced contract); no network
```

41 tests, all passing, none skipped. They cover identity and idempotency, conflict on re-assertion, revision with
history, provenance preservation, dangling and reflexive relationships, durability across reopen, the FeltDB contract
refusing a second contract and an undeclared collection, every projection and journey, validator negatives for every
kind, schema/validator agreement for both contracts, publisher issue/authenticate/revoke and the refusals around
them, publisher and namespace isolation, the five acceptance answers with "a refusal writes nothing", batch ordering
and the batch limit, that acceptance derives nothing, repository and product registration with its verified history,
and recovery of every collection after closing and reopening the store.

## Not in scope (deliberately)

| Not here | Why | Depends on |
|---|---|---|
| An HTTP surface | authentication and acceptance are here as functions (`PublisherDirectory`, `EventAcceptor`); routing them needs a deployment | Q1 (FeltDB authority) |
| Operator authentication | `issue` and `revoke` are operator acts; whoever calls them owns authenticating the operator, exactly as the old implementation's owner token lived in its HTTP layer | Q2 (owner identity) |
| Deployment, configuration, a Vercel function | no FeltDB authority has been chosen; `server:` mode is unverified | Q1 |
| Dashboards | projections exist; rendering them is a later PR, and a dashboard is never an authority | later |
| A GitHub sync job | would create `repository` and `released-from` references from GitHub; needs an integration identity, a credential home and a schedule | Q1, Q6 |
| A product-side event emitter, metrics, rate windows, retention sweeping | each needs a deployment or a schedule; the old implementation's designs stand and are not migrated | Q1 |
| Reading or interpreting accepted events | acceptance stores; attribution, counting and ranking are a reader's work over the stored bytes | later |
| Deletion or retraction of records | revision with history covers correction; retraction semantics (and what happens to relationships) are undecided | later |

- [`docs/integration-contracts.md`](docs/integration-contracts.md) — publisher identity and scopes, how GitHub and a
  product register, the registration lifecycle, the event envelope, the acceptance answers, and the isolation that is
  actually enforced.
- [`docs/agent-feedback/`](docs/agent-feedback/README.md) — feedback from the agents that build and operate the
  ecosystem, one session per file, as `boundry.event/1` envelopes that a test replays through the real acceptor. An
  interim representation until there is an acceptor to reach, never a second feedback store.
- [`docs/intelligence-evaluation.md`](docs/intelligence-evaluation.md) — the evaluation of the old implementation:
  what was reused, migrated and left behind, and how registry records relate to `boundry.event/1` events.
