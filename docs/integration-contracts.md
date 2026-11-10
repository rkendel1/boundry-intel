# Integration contracts

How GitHub and individual Boundry products register themselves with Boundry Intel, how they authenticate, what they
may then say, and what happens to an event once it has been accepted. Three contracts, each versioned and each
deterministic: a **publisher identity** (who may speak), a **registration** (that a subject registered, and whether
that was verified), and the **event envelope** `boundry.event/1` (what a product reports).

Everything here is a library with functions. No HTTP surface, no port, no deployment, no scheduler, and no
assumption about where FeltDB runs. A caller — a future HTTP surface, a CLI, an operator's script — owns transport
and owns authenticating the *operator*; this repository owns authenticating the *publisher* and deciding what it may
do.

## 1. Publisher identity

A **publisher** is an authenticated identity bound to exactly one subject with a closed set of scopes. The subject
binding is the isolation boundary, and it is checked on every call.

| | |
|---|---|
| Subject | one `product:<productId>` or one `repository:<host>/<owner>/<name>` (`PUBLISHER_SUBJECT_KINDS`) |
| Key format | `bik_<12 hex publisher id>_<43 base64url secret>` |
| Stored | the SHA-256 hash of the key, and nothing else |
| Compared | `timingSafeEqual`, after a cheap format check so a malformed key costs no lookup |
| Scopes | `events:write`, `registry:assert`, `registration:verify` (`PUBLISHER_SCOPES`; closed) |
| Lifecycle | `issue` → used (`lastUsedAt`) → `revoke`; revocation is idempotent and never deletes the record |

```js
const publishers = new PublisherDirectory(db);
const { publisher, key } = await publishers.issue({
  subject: 'product:feltdb',
  name: 'FeltDB production emitter',
  scopes: ['events:write'],
  createdBy: 'operator:randy',
});
// `key` is returned once, here, and never again. A lost key is revoked and reissued, not recovered.
```

Nothing in the directory returns, logs or echoes a key. `authenticate` answers `null` for an unknown, malformed or
revoked key — the same answer in every case, so an unauthenticated caller cannot tell them apart by the shape of the
failure.

### What a publisher may do

`authorizes(publisher, { scope, subject, productId })` is a pure function, so an authority decision can be read,
tested and logged without a database:

| Refusal | Means |
|---|---|
| `publisher.revoked` | the publisher is absent or revoked |
| `publisher.scope` | the publisher does not hold the required scope |
| `publisher.subject` | the thing being acted on is not this publisher's subject |

**Authority is never inherited through the registry.** A key bound to `repository:github.com/o/n` does not speak for
whatever product that repository belongs to, even though the registry records a `repository-of` relationship between
them. The registry's own statements about ownership are statements, not credentials.

A publisher is deliberately **not** a `boundry.registry/1` document. A registry document is a readable statement that
projections hand out whole, and a credential has no business in one. The public fact that a subject registered lives
in the registry as a relationship; the credential lives in `intel_publishers`.

## 2. Registration: `registered-with`

Registration is a **relationship**, not a document kind. `registered-with` runs from the subject that registered to
the `integration` it registered with:

| | |
|---|---|
| `from` | `product` or `repository` |
| `to` | `integration` |
| `status` (**required**) | `pending`, `verified`, `failed`, `revoked` |
| `method` | `github-app`, `publisher-key`, `manifest`, `operator` |
| `lastVerifiedAt` | RFC 3339, the time of the last successful verification |
| `publisher` | the 12-hex publisher id that proved it, when a key was the method |

Three consequences follow from it being a relationship rather than a kind, and they are the reason for the choice:

1. **No dangling registration.** `from` and `to` are FeltDB reference fields, so registering a product that is not
   recorded, or with an integration that is not recorded, is refused at commit. An entity cannot be deleted while a
   registration names it.
2. **The status history is already durable.** Moving `pending` → `verified` is a `revise`, so the superseded
   statement lands in `registry_revisions` with its own provenance and `recordedAt`. There is no second lifecycle
   store, and no field that silently overwrites what it used to say.
3. **One subject, one registration per integration.** The relationship id is derived from `(type, from, to)`, so a
   duplicate registration is `unchanged` or a `conflict`, never a second row.

### How GitHub registers a repository

The GitHub App is an `integration` document (`integrationKind: "github-app"`, with its `boundary` declaring mode and
scopes). Registering a repository is then three assertions and one revision:

```js
await registry.assertAll([
  repositoryDocument,                                                  // repository:github.com/rkendel1/flow_db
  githubAppIntegration,                                                // integration:github-app
  relationship('registered-with', repoId, 'integration:github-app',    // status: pending
    { status: 'pending', method: 'github-app' }, { provenance: observation(...) }),
]);
// … the App installation is confirmed …
await registry.revise(
  relationship('registered-with', repoId, 'integration:github-app',
    { status: 'verified', method: 'github-app', lastVerifiedAt: '2026-11-09T12:00:00Z' }, { provenance: observation(...) }),
  { expectedDigest: pending.digest },
);
```

Verification itself is the caller's: this repository does not call GitHub. What it owns is that the claim is
recorded, attributable, and that its history survives.

### How a product registers itself

The same shape, with `method: "publisher-key"` and the `publisher` attribute naming the key that proved it. A
publisher that may do this holds the `registration:verify` scope; `events:write` alone does not let a product declare
itself verified.

## 3. The event envelope: `boundry.event/1`

Normative schema: [`../schema/boundry-event-1.schema.json`](../schema/boundry-event-1.schema.json). Reference
validator: `validateEvent` in [`../src/events.mjs`](../src/events.mjs). Both are migrated unchanged from
`rkendel1/boundry` `intelligence/`, so a key and an envelope that the old implementation accepted are accepted here.

Required members: `schema`, `id`, `type`, `occurredAt`, `product` (`{ id, version }`). Nine types, closed in `/1`:
`product.discovered`, `product.used`, `capability.invoked`, `task.completed`, `task.failed`, `feedback.submitted`,
`feedback.updated`, `product.improved`, `product.released`.

**Identity is `(product.id, id)`.** The same pair is the registry's event reference `event:<productId>:<eventId>` and
the event store's FeltDB key, derived from the same two strings, so following an `evidenced-by` edge from a registry
record into the event store needs no mapping table. `test/events.test.mjs` pins this behaviourally: for a list of
ids, valid and invalid, an id is accepted by the event validator exactly when the matching registry reference is a
valid registry id.

Idempotency is the **canonical digest** of the envelope: RFC 8785 canonical JSON and SHA-256, so member order never
changes an event's identity and content always does.

## 4. Acceptance, and what it refuses to do

`EventAcceptor.accept(presentedKey, envelopes)` authenticates once for the batch and answers once per envelope, in
order, so a publisher learns exactly which of its events landed. At most `MAX_BATCH` (100) envelopes per call.

| Answer | Meaning | Retry |
|---|---|---|
| `accepted` | validated, authorized and **committed** before the call returned | no |
| `duplicate` | that identity is stored with the same canonical digest: an idempotent resend | no |
| `conflict` | that identity is stored with *different* content; nothing was written | never |
| `rejected` | invalid under `boundry.event/1`; nothing was written; `issues` say what | never |
| `unauthorized` | the key is unknown, revoked, lacks `events:write`, or the event is another product's | never |

A storage failure **throws** rather than answering. A caller's surface should report that as unavailable so the
publisher resends the same batch, which is safe precisely because identity is `(product.id, id)`.

Two properties are tested rather than asserted in prose:

- **A refusal writes nothing at all.** Every refusing path leaves the store's event count unchanged, so a
  misbehaving or hostile client cannot grow the store by being wrong.
- **Acceptance interprets nothing.** The stored record is the envelope verbatim beside its digest and the few
  members needed to find it again: id, product, version, type, schema, occurrence and receipt time, publisher,
  reference, correlation. Not one derived fact — no attribution, no identity class, no confidence, no feedback links,
  no counters. The test asserts the record's exact key set, and asserts that those derived columns of the old
  implementation are absent.

That separation is the point, and it is why acceptance is a different module from projection. An interpretation that
changes must never require rewriting an immutable record of what was reported. Reading is a reader's work over the
stored bytes.

## 5. The isolation that is actually enforced

Stated plainly, because "isolation" can mean several things and only two of them are implemented here:

| Boundary | Enforced | How |
|---|---|---|
| **Publisher** | yes | the subject binding of the key, checked on every accept and every authority decision, against the key's own record and never against anything the envelope claims about itself |
| **Application / namespace** | yes | one FeltDB application contract per store; a store governed by another contract is refused, an undeclared collection is refused, and two namespaces share nothing |
| **Per-tenant partitioning inside one application** | **no** | not implemented. There is no tenant column, no row-level scoping, and nothing that would let one application instance hold two mutually invisible tenants. A deployment that needs that today separates them by FeltDB namespace. |

## 6. What is deliberately absent

The old implementation's HTTP routes, fail-open product emitter, metrics aggregates, rate windows, retention
sweeping, access audit and Vercel adapter are **not** migrated. Each needs a deployment decision this repository does
not make, and the first of those decisions — which FeltDB authority hosts this — is still open (Q1 in
[`intelligence-evaluation.md`](intelligence-evaluation.md)). The envelope, the key format and the acceptance
semantics are migrated so that those surfaces can be added later without reissuing a key or changing a contract.

No dashboards, no autonomous agents, no AI-driven decisions, and no product-specific event forwarders. Every function
in this package is deterministic; there is no model call anywhere in it.
