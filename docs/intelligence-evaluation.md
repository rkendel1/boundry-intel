# Evaluation of the old `intelligence/` implementation

What this repository reuses, migrates and leaves behind from `rkendel1/boundry` `intelligence/`
(`@boundry/intelligence` 0.1.0, private; merged in boundry#7), evaluated against the Phase 0 audit
(`docs/architecture/ecosystem-intelligence.md`, `docs/architecture/ecosystem-events.md` in that repository)
and the registry this PR establishes. Written from the code as it is in that checkout, not from its README.

## 1. Summary

| `intelligence/` piece | Lines | Decision | Where it lands here |
|---|---|---|---|
| `src/contract.mjs` (`boundry.event/1` reference validator) | 401 | **migrated unchanged** | `src/events.mjs`, copied character for character from commit 3622623 with a provenance header added and nothing else. The registry validator (`src/contract.mjs`) separately reuses its *pattern* (a pure `Checker`, `{ code, pointer, message }` issues, closed objects, canonical digest, credential floor via `@appport/protocol`) and shares its grammars: `PRODUCT_ID`, `IDENTIFIER`, `VERSION`, `TIMESTAMP`, the control-character rule for labels, `PRINCIPAL_TYPES`. |
| `schema/boundry-event-1.schema.json` | — | **migrated unchanged** | `schema/boundry-event-1.schema.json`, byte-identical. `test/events.test.mjs` proves it still agrees with the migrated validator through `@appport/schema` `fromJSONSchema`. |
| `test/schema.test.mjs` (schema ↔ validator agreement) | — | **pattern reused** | `schema/boundry-registry-1.schema.json` is the normative registry schema and `test/schema.test.mjs` proves it agrees with the registry validator the same way. |
| `src/store.mjs` (`IntelligenceStore`, `INTELLIGENCE_CONTRACT`) | 404 | **storage pattern, identity semantics and key format migrated; the derived columns and the operational collections left behind** | `RegistryStore` uses the same FeltDB primitives the audit §5 approved (`defineStateContract`, transactions, `requireAbsent`, `expectedVersion`, equality indexes), the same digest-based FeltDB ids (`key(prefix, parts)`), the same bounded `find()` pager and the same `requireAbsent` → compare-digest → `duplicate | conflict` decision (`unchanged | conflict` here). It adds two things the event store did not need: a FeltDB **unique constraint** on the readable registry id and **reference fields** for relationship endpoints. `EventAcceptor` (`src/acceptance.mjs`) takes `ingest`/`#store`'s identity, idempotency and answer semantics directly, and `PublisherDirectory` (`src/publishers.mjs`) takes `issueSource`/`authenticateSource`/`revokeSource`'s key format, hash-only storage, constant-time compare and revocation. What is not recreated: `intelligence_feedback_links`, `intelligence_rate_windows`, `intelligence_access_audit`, and the old event record's derived attribution columns — see §3. |
| `test/support.mjs` (`openDb`: `createFeltDB({ mode: 'local' })` + `stateContract.evolve`) | 47 | **reused as the test harness pattern** | `test/support.mjs` here; every test runs on a real local FeltDB in a temporary directory with the registry contract enforced. |
| `src/http.mjs` (ingestion + owner routes) | 153 | **left behind** | acceptance and authentication are here as functions; routing them depends on Q1 (which FeltDB authority) and Q2 (owner identity). This package exposes functions, not routes, and opens no port. |
| `src/emitter.mjs` (fail-open product emitter) | 119 | **left behind** | product-side code for events; nothing in a registry emits. Still the right design for events (audit §5 of ecosystem-events.md). |
| `src/metrics.mjs` | 111 | **left behind** | event aggregates; a dashboard projection over events, not registry state. The registry's projections (`src/projections.mjs`) are over registry records only and never count events. |
| `src/configure.mjs`, `api/intelligence.mjs`, `vercel.json` rewrite | 19 + adapter | **left behind** | deployment to Vercel against a remote FeltDB (`server:` mode) is the unresolved Q1; nothing here assumes a network path. |
| `@appport/protocol` 1.5.0 dependency | — | **reused** | `canonicalize`, `digestOf`, `detectSensitive`, `FEEDBACK_INTEGRATION_MECHANISMS` (the `provides.mechanism` vocabulary is `appport.feedback/1`'s, as the audit asked). |
| `@feltdb/core` 0.21.0 dependency | — | **reused** | pinned `>=0.21.0 <1.0.0` as FeltKit pins it; the lockfile resolves 0.21.0. |

Nothing in `intelligence/` was changed, and the old repository is untouched.

## 2. What the audit decided that this PR relies on

- **Ownership** (audit §3): cross-product, Boundry-owned state belongs where Boundry, not a product, is the subject.
  Boundry Intel is that place now; the registry is the first thing in it.
- **FeltDB as substrate, not owner** (§5): one application contract, generic primitives, no FeltDB code change.
  `BOUNDRY_INTEL_CONTRACT` is such a contract, and it is one contract over every collection this system owns — the
  registry's, the publisher directory's and the event store's — because FeltDB governs a store with exactly one.
  On a managed authority it would be published and promoted exactly as
  `INTELLIGENCE_CONTRACT` was going to be (`provision.mjs` flow); on the local runtime `prepare(db)`
  installs it with `stateContract.evolve`.
- **Provenance vocabulary** (§7): disclosures and attribution are the event contract's business. The registry's
  provenance is a different, smaller thing: *where a registry statement came from and whether it points at an
  authority*. It does not reuse `asserted | verified | withheld | unavailable` because a registry record is not a
  reporter's disclosure about an actor; it is Boundry's own pointer or observation. The two vocabularies are kept
  apart deliberately so that neither leaks into the other.
- **Q1 is unresolved** (§10, §12): the only running FeltDB control plane is Fly `api.feltdb.com`; no Hetzner platform
  is installed. Nothing here is configured against either. The store takes a `StateFirstDB` and works on
  `createFeltDB({ mode: 'local' })`; `server:` mode is the same interface and is **not verified** here.

## 3. The event contract: migrated, and how the two contracts join

The audit's sequence (§13) placed the event contract's move in this repository once there was something to accept
events into. `src/acceptance.mjs` is that, so the contract has moved: `src/events.mjs` and
`schema/boundry-event-1.schema.json` are copied from commit 3622623 unchanged, and the key format is unchanged too,
so a key issued by either implementation is recognized by this one and the old repository's ingestion function can be
retired without reissuing keys.

The old repository keeps its copy until its Vercel function is retired, which means the two copies must not drift.
`test/events.test.mjs` pins what matters about that rather than comparing regular expressions: for a list of product
ids and event ids, valid and invalid, an id is accepted by the event validator exactly when the matching registry id
or event reference is a valid registry id. That is the property a caller actually experiences — the registry can
point at exactly the events the acceptor can store, and at no others.

| Event member (`boundry.event/1`) | Registry id it names | Rule |
|---|---|---|
| `product.id` | `product:<product.id>` | same `PRODUCT_ID` grammar in both validators |
| `product.id` + `product.version` | `product-version:<product.id>@<product.version>` | same `VERSION` grammar |
| `capability.name` (+ `capability.version`) | `capability:<name>[@<version>]` | the registry's `CAPABILITY_NAME` is the dotted form the event examples use (`invoices.create`); the event validator accepts any label, so an event capability that is not a dotted name has no registry id. This is the one place the two contracts are not symmetric; it is noted, not papered over. |
| `data.version` of `product.released` | `product-version:<product.id>@<data.version>` | a `product.released` event is the natural **evidence** for a `product-version` record |
| the event's identity `(product.id, id)` | `event:<product.id>:<id>` | an **event reference**, never a copy: the registry stores no event member other than, optionally, `eventType` and `occurredAt` on an `evidenced-by` relationship |

Direction of reference: **events may name registry ids** (they already do, implicitly, through `product.id` and
`capability`); **registry records name events only by reference** (`evidenced-by`), and a journey stops at an event
reference. The event store's `ev_<digest of [product.id, id]>` key and the registry's `event:<product.id>:<id>`
reference are derived from the same pair, so a read that follows an `evidenced-by` edge into the event store needs no
mapping table.

### What was left behind, and why

| Left in `rkendel1/boundry` | Why |
|---|---|
| `src/http.mjs`, `src/configure.mjs`, `api/intelligence.mjs`, the `vercel.json` rewrite | a deployment decision; Q1 is open |
| `src/emitter.mjs` | product-side code; nothing in this repository emits, and product-specific forwarders are explicitly out of scope |
| `src/metrics.mjs` | an aggregate over events is a reader's work, not the write path's |
| `intelligence_rate_windows`, `intelligence_access_audit` | operational controls for a deployed surface; they belong with the surface that needs them, and the designs stand |
| `intelligence_feedback_links` and the event record's derived columns (attribution, identity class, confidence, feedback ids) | derived facts on the write path. An interpretation that changes must never require rewriting an immutable record of what was reported, so acceptance stores the envelope verbatim and derives nothing. `feedbackIdsOf` and `attribute` are still exported from `src/events.mjs` for a reader to use over stored bytes. |
| Retention sweeping | needs a schedule this repository does not assume |

What is **not** done: acceptance does not check `product.id` against the registry. It checks it against the
publisher key's subject binding, which is the right authority for "may this publisher report for this product".
Whether acceptance should additionally require a registry `product` record is a later decision; it would couple
acceptance availability to the registry, which the fail-open design has so far avoided.

## 4. Things the registry deliberately does differently

- **Revision with history.** Events are immutable; a registry statement about a product can legitimately change (a
  name, a status, a default branch). `assert` is still once-only and conflicts on different content, exactly like
  ingestion; `revise(document, { expectedDigest })` is the explicit, compare-and-set path, and the superseded
  document is kept in `registry_revisions` in the same transaction. There is no silent overwrite.
- **Endpoint integrity at the authority.** A relationship's `from` and `to` are FeltDB reference fields, so a dangling
  relationship is refused at commit and an entity cannot be deleted while a relationship names it. The event store
  had no such need (links are to feedback ids, which are not records).
- **Credentials are not registry documents.** A `boundry.registry/1` document is a readable statement that
  projections hand out whole, so a publisher key has no business in one. `intel_publishers` holds the credential;
  the registry holds the public fact that a subject registered, as a `registered-with` relationship. Rate windows and
  the access audit are still absent, because they control a deployed surface this package does not provide; when one
  is added it should reuse the old implementation's designs rather than invent another.
- **Registration is a relationship, not a kind.** `registered-with` makes FeltDB's reference fields refuse a dangling
  registration, and makes `registry_revisions` the status history, so there is no second feedback-or-registration
  lifecycle store and no field that silently overwrites what it used to say.

## 5. Risks carried forward

- The `server:` mode (remote authority) is unverified for both stores; the local runtime enforced the contract in every
  test here, but publication through the management API and behaviour under concurrent writers are Q1 work.
- The registry's `capability` grammar is stricter than the event contract's `capability.name` label (§3). If a product
  reports non-dotted capability names, either the event contract tightens in `/2` or the registry adds an alias.
- `RELATIONSHIP_TYPES` grew in `/1` — `depends-on`, `component-of` and `registered-with` were added to the closed
  set rather than minted as `boundry.registry/2`. That is sound **only** because `/1` is unpublished and unconsumed
  while its own PR is still open: no caller can have read the narrower set. Once `/1` is published, the evolution
  rule of `boundry.event/1` applies and a new relationship type is a `/2`, not a quiet addition. This is the one place
  where the contract was changed rather than versioned, and it closes the moment the registry PR merges.
- Attribute names in `ATTRIBUTE_CHECKS` are global: `status` means a registration status everywhere, not just on
  `registered-with`. A future relationship type that wants a different `status` vocabulary needs a different attribute
  name, or that table has to become per-type.
