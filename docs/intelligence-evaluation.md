# Evaluation of the old `intelligence/` implementation

What this repository reuses, migrates and leaves behind from `rkendel1/boundry` `intelligence/`
(`@boundry/intelligence` 0.1.0, private; merged in boundry#7), evaluated against the Phase 0 audit
(`docs/architecture/ecosystem-intelligence.md`, `docs/architecture/ecosystem-events.md` in that repository)
and the registry this PR establishes. Written from the code as it is in that checkout, not from its README.

## 1. Summary

| `intelligence/` piece | Lines | Decision | Where it lands here |
|---|---|---|---|
| `src/contract.mjs` (`boundry.event/1` reference validator) | 401 | **reused as the sibling contract, not copied** | the registry validator (`src/contract.mjs`) reuses its *pattern* (a pure `Checker`, `{ code, pointer, message }` issues, closed objects, canonical digest, credential floor via `@appport/protocol`) and copies its shared grammars character for character: `PRODUCT_ID`, `IDENTIFIER`, `VERSION`, `TIMESTAMP`, the control-character rule for labels, `PRINCIPAL_TYPES`. The event validator itself is not vendored: the registry never validates events. |
| `schema/boundry-event-1.schema.json` + `test/schema.test.mjs` | — | **pattern reused** | `schema/boundry-registry-1.schema.json` is the normative registry schema and `test/schema.test.mjs` proves it agrees with the reference validator through `@appport/schema` `fromJSONSchema`, exactly as the event package does. |
| `src/store.mjs` (`IntelligenceStore`, `INTELLIGENCE_CONTRACT`) | 404 | **storage pattern migrated; event store not moved** | `RegistryStore` uses the same FeltDB primitives the audit §5 approved (`defineStateContract`, transactions, `requireAbsent`, `expectedVersion`, equality indexes), the same digest-based FeltDB ids (`key(prefix, parts)`), the same bounded `find()` pager and the same `requireAbsent` → compare-digest → `duplicate | conflict` decision (`unchanged | conflict` here). It adds two things the event store did not need: a FeltDB **unique constraint** on the readable registry id and **reference fields** for relationship endpoints. The event collections (`intelligence_events`, `intelligence_feedback_links`, `intelligence_sources`, `intelligence_rate_windows`, `intelligence_access_audit`) are not recreated here: see §3. |
| `test/support.mjs` (`openDb`: `createFeltDB({ mode: 'local' })` + `stateContract.evolve`) | 47 | **reused as the test harness pattern** | `test/support.mjs` here; every test runs on a real local FeltDB in a temporary directory with the registry contract enforced. |
| `src/http.mjs` (ingestion + owner routes) | 153 | **left behind** | an ingestion endpoint is explicitly out of scope; it depends on Q1 (which FeltDB authority) and Q2 (owner identity). The registry exposes functions, not routes. |
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
  `REGISTRY_CONTRACT` is such a contract. On a managed authority it would be published and promoted exactly as
  `INTELLIGENCE_CONTRACT` was going to be (`provision.mjs` flow); on the local runtime `RegistryStore.prepare(db)`
  installs it with `stateContract.evolve`.
- **Provenance vocabulary** (§7): disclosures and attribution are the event contract's business. The registry's
  provenance is a different, smaller thing: *where a registry statement came from and whether it points at an
  authority*. It does not reuse `asserted | verified | withheld | unavailable` because a registry record is not a
  reporter's disclosure about an actor; it is Boundry's own pointer or observation. The two vocabularies are kept
  apart deliberately so that neither leaks into the other.
- **Q1 is unresolved** (§10, §12): the only running FeltDB control plane is Fly `api.feltdb.com`; no Hetzner platform
  is installed. Nothing here is configured against either. The store takes a `StateFirstDB` and works on
  `createFeltDB({ mode: 'local' })`; `server:` mode is the same interface and is **not verified** here.

## 3. The event store: why it is not moved in this PR, and how the two relate

The audit's sequence (§13) has the event store's first real test as "the intelligence suite run against the remote
authority" (step 1), which needs Q1. Moving `IntelligenceStore` into this repository before that would either
duplicate it (two copies of one store, neither deployed) or orphan the Vercel function that still imports it from
`intelligence/`. So the event store stays where it is until the ingestion PR, and this PR fixes the **join** between
registry and events instead, so that the move is mechanical when it happens:

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
reference are derived from the same pair, so a future read that follows an `evidenced-by` edge into the event store
needs no mapping table.

What is **not** done: the event store does not check `product.id` against the registry (it checks it against the
ingestion key, which is the right authority for "may this source report for this product"). Whether ingestion should
additionally require a registry `product` record is a later decision; it would couple ingestion availability to the
registry, which the fail-open design has so far avoided.

## 4. Things the registry deliberately does differently

- **Revision with history.** Events are immutable; a registry statement about a product can legitimately change (a
  name, a status, a default branch). `assert` is still once-only and conflicts on different content, exactly like
  ingestion; `revise(document, { expectedDigest })` is the explicit, compare-and-set path, and the superseded
  document is kept in `registry_revisions` in the same transaction. There is no silent overwrite.
- **Endpoint integrity at the authority.** A relationship's `from` and `to` are FeltDB reference fields, so a dangling
  relationship is refused at commit and an entity cannot be deleted while a relationship names it. The event store
  had no such need (links are to feedback ids, which are not records).
- **No sources, keys, rate windows or audit.** Those exist to authenticate remote writers and readers. The registry
  has no remote writers or readers in this PR; when an ingestion or sync path is added it should reuse the event
  store's source/audit design rather than invent another.

## 5. Risks carried forward

- The `server:` mode (remote authority) is unverified for both stores; the local runtime enforced the contract in every
  test here, but publication through the management API and behaviour under concurrent writers are Q1 work.
- The registry's `capability` grammar is stricter than the event contract's `capability.name` label (§3). If a product
  reports non-dotted capability names, either the event contract tightens in `/2` or the registry adds an alias.
- `RELATIONSHIP_TYPES` is closed in `/1`. New relationship types (for example `depends-on`) are a `/2`, not a quiet
  addition, by the same evolution rule as `boundry.event/1`.
