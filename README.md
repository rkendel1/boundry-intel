# Boundry Intel

The Boundry ecosystem registry: stable identities for products, product versions, GitHub repositories, capabilities
and integrations, the explicit relationships between them, and the provenance of every statement, stored on FeltDB
as **attributable references and observations**. It is the foundation future integrations and dashboards read from.
It is not an ingestion service, a sync job, a deployment or a dashboard (see "Not in scope").

`@boundry/intel-registry` 0.1.0 (private). Plain Node ESM, no build step, no LLM anywhere.

## Architectural rules

These are the rules the registry is built to, and the ones a change must not break.

| Rule | How the registry keeps it |
|---|---|
| **GitHub remains authoritative for GitHub activity.** | A `repository` record is a *reference* (`provenance.kind: "reference"`, `source.system: "github"`, a locator into GitHub). The registry stores identity and a pointer, never commits, issues or activity. |
| **Product repositories remain authoritative for their code and releases.** | A `product-version` and its `released-from` relationship carry the tag, commit and release URL as a reference into the repository. No changelog, artifact or code is copied. |
| **Boundry Intel stores attributable references and observations, not duplicate copies.** | Every record has `provenance`: `kind` (`reference` to an authority or `observation` by Boundry), `source` (system and locator), `assertedBy` (who or what), `observedAt` (the source's time) and `recordedAt` (the registry's clock, set by the store). Documents are closed (unknown members refused) and at most 16 KiB, so there is no room for a copy of anything. |
| **FeltDB remains the durable state foundation.** | One FeltDB application state contract (`REGISTRY_CONTRACT`), generic primitives only: transactions, `requireAbsent`, `expectedVersion`, a unique constraint, reference fields, equality indexes. No FeltDB code is changed; no second database exists. |
| **Dashboards are projections, never authorities.** | `src/projections.mjs` is read-only and deterministic: the same registry state gives the same projection. A projection carries each record's provenance so a dashboard can show *where a fact came from* and link back to the authority. |
| **No new control plane or database.** | The store takes a `StateFirstDB` from `@feltdb/core`; tests use `createFeltDB({ mode: "local" })` in a temporary directory. Which FeltDB authority hosts it later is the owner's open question Q1 (see `docs/intelligence-evaluation.md`); nothing here assumes an answer. |
| **Useful without an LLM.** | Validation, identity, storage and every query are deterministic functions. There is no inference, ranking, summarisation or model call in this package, and its dependencies carry none into the registry path. |
| **Reuse before invention.** | Product and event id grammars are `boundry.event/1`'s; `provides.mechanism` is `appport.feedback/1`'s integration-mechanism vocabulary; digests and the credential floor are `@appport/protocol`'s; the FeltDB contract pattern is the one `FeltDbFeedbackStore` and the old event store use. |

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

`from` and `to` must be recorded (the store refuses a dangling relationship, and FeltDB refuses deleting an entity a
relationship still names). An **event reference** `event:<productId>:<eventId>` is the `boundry.event/1` identity
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
import { RegistryStore, productProjection } from '@boundry/intel-registry';

const db = createFeltDB({ mode: 'local', namespace: 'boundry-intel-registry', path: './data', access: 'shared' });
await RegistryStore.prepare(db);                       // installs REGISTRY_CONTRACT once (stateContract.evolve)
const registry = new RegistryStore(db);

const r = await registry.assert({ schema: 'boundry.registry/1', kind: 'product', productId: 'feltdb', name: 'FeltDB', provenance });
// r.status: 'recorded' | 'unchanged' | 'conflict' | 'rejected'
```

| Operation | Semantics |
|---|---|
| `assert(document)` | once, under the derived id, with `requireAbsent`. `recorded` (committed before returning), `unchanged` (same digest; idempotent), `conflict` (same id, different content; nothing written; `current` returned), `rejected` (invalid or dangling; `issues`). |
| `revise(document, { expectedDigest })` | compare-and-set replacement. `revised`, `unchanged`, `conflict` (`registry.digest.stale`), `missing`, `rejected`. The superseded document is appended to `registry_revisions` in the same transaction. |
| `assertAll(documents)` | in order; one result each. |
| `get(id)` · `list({ kind, productId, relationshipType, fromId, toId })` · `relationships({ from, to, type })` · `history(id)` | reads; sorted by id; bounded. |

FeltDB collections: `registry_records` (one per registry id; unique on `registryId`; indexes on kind, product,
relationship type, from, to; `fromKey`/`toKey` are reference fields) and `registry_revisions` (append-only). FeltDB
record ids are digests of the registry id (`reg_<hex>`) because FeltDB ids cannot carry `:`, `/` or `@`; the readable
id is the unique field. The digest of a document is RFC 8785 canonical JSON + SHA-256 over the assertion (everything
but `recordedAt`).

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

Tests cover identity and idempotency, conflict on re-assertion, revision with history, provenance preservation,
dangling and reflexive relationships, durability across reopen, the FeltDB contract refusing undeclared fields and
collections, every projection and journey, validator negatives for every kind, and schema/validator agreement.

## Not in scope (deliberately)

| Not here | Why | Depends on |
|---|---|---|
| An ingestion or write endpoint | the registry is a library with functions; who may write, and how they authenticate, is the same question the event ingestion has | Q1 (FeltDB authority), Q2 (owner identity) |
| Deployment, configuration, a Vercel function | no FeltDB authority has been chosen; `server:` mode is unverified | Q1 |
| Dashboards | projections exist; rendering them is a later PR, and a dashboard is never an authority | this PR |
| A GitHub sync job | would create `repository` and `released-from` references from GitHub; needs an integration identity, a credential home and a schedule | Q1, Q6 |
| Moving the event store (`intelligence_*` collections) | stays in `rkendel1/boundry` until the ingestion PR; the join to it is fixed here (`evidenced-by`, shared id grammars) | audit §13 step 1 |
| Deletion or retraction of records | revision with history covers correction; retraction semantics (and what happens to relationships) are undecided | later |

The evaluation of the old implementation, what was reused, migrated and left behind, and how registry records
relate to `boundry.event/1` events: [`docs/intelligence-evaluation.md`](docs/intelligence-evaluation.md).
