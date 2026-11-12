# Outcome-driven service business: verified Boundry stack inventory

**Purpose.** Step 1 of the "Outcome-Driven Service Business" building specification (§27.1): replace the
status labels in its §3 boundary map with facts taken from the code, and answer what the code can answer from §26
(open decisions). This document builds nothing. It records what exists so that the contract kernel (§27.2–3) is
designed against the real stack, not the named one.

**Date:** 2026-11-12. **Method:** read-only shallow clones at the commits below. Every claim marked *code* was read in
source; *code+test* means a test exercises it; *doc* means it appears only in docs or plans. Test suites in the other
repos were **not run**. This repository's own suite was run (85/85 passing).

| Repo | Commit | How read |
|---|---|---|
| rkendel1/feltkit | f7febca | clone |
| rkendel1/appboundry | d791879 | clone |
| rkendel1/authboundry | da46b26 | clone |
| rkendel1/appport | e91fd39 | clone |
| rkendel1/resolver | 5c827aa | clone |
| rkendel1/resolver-control | d41ef9e | clone |
| rkendel1/pax | aab5039 | clone |
| rkendel1/boundry | 3a5400d | clone |
| FeltDB | `@feltdb/core` 0.21.0 | published package only. The `flow_db` source repo was **not** read (access not granted to this session). |

## 1. Headline

The named stack is real, but **five of the eight roles the spec gives it are different from what the components
do**. The pieces the spec actually needs (durable conditional state, delegated grants with expiry and revocation,
digest-bound human approval, idempotent capability invocation, capability composition) exist, but in different
components than the spec places them in. Three things the spec takes as given exist **nowhere**:

1. an intake/requirement resolver that turns a customer outcome into questions and a plan;
2. a durable execution runtime with retries, timeouts, pause/resume and compensation;
3. a commercial domain: contract, quote, order, deliverable, acceptance, invoice.

These are the product. Everything else is reuse.

## 2. Corrected boundary map (replaces spec §3)

| Spec name | Spec's proposed role | What it actually is (evidence) | Fit | Use in this product |
|---|---|---|---|---|
| **FeltDB** | Durable facts, versions, evidence refs, projections | Application database with one state contract per store **name**. Atomic multi-collection transactions; `requireAbsent`, `expectedVersion`, preconditions, idempotent `transactionId`; enforced `unique` and `reference` fields; content-addressed `storeContent`/`acquireContent` (sha256); `snapshot()` read models; `subscribe()`. *code* (`@feltdb/core` dist: `transaction.d.ts:79-117`, `application-state-contract.d.ts:114-139`, `db.d.ts:601-621`). Local mode *code+test* here (`test/integration.test.mjs`). | **Good**, with gaps | Authority for all order facts. **Gaps:** no native append-only or immutable collection (append-only is a convention: `requireAbsent` plus a history collection, as `src/store.mjs` does). No row-level tenancy: the namespace is the only tenant boundary verified (`docs/deployment.md`). Remote/managed mode is **not verified** (`docs/deployment.md` §10: production fell back to embedded local after HTTP 403s). |
| **AppPort** | Stable boundary for commands, queries, adapters | Capability contract protocol: manifest with input/output schema, scopes, `effect: observation \| consequential`, idempotency declaration (`protocol/src/manifest.ts:57-97`, `authorization.ts:4`). Consequential capabilities are refused without a real authorizer (`core/src/application.ts:247,807`). Idempotency keys bound to a request digest, *code+test* (`core/test/idempotency-binding.test.ts`). Transports: HTTP, WS, in-process, MCP. | **Good** | Every capability, both the customer-facing API and the internal fulfillment units, is an AppPort capability. **Gaps:** no cost or usage metadata on capabilities. `approval` is a declaration only ("AppPort does not collect, check or record approvals", `protocol/src/integration.ts:170-174`). AppPort's own grants are app→provider with no expiry (`core/src/authorization-grant.ts:30-35`), so they are not customer grants. No HTTP idempotency header found. |
| **AuthBoundry** | Identity, tenancy, delegated authority, consent, policy | Rust policy service. Tenants; `Delegation{capabilities, resource_scope, expires_at, revoked_at, chain}` (`crates/contract/src/delegation.rs`); denial reasons `delegation_expired`, `delegation_revoked`, `delegation_exceeds_authority`; explainable decisions; separate human, agent and service principals with agent credential suspend/revoke; append-only audit that **fails closed** if unavailable. *code+test* (`server/tests/effective_authority_nonescalation.rs`, `authority_enforcement_audit.rs`). AppPort adapter `createAuthBoundryAuthorizer` (dist only). | **Strongest fit** | Customer `ResourceGrant` = an AuthBoundry delegation scoped to the order. **Gaps:** no purpose binding, no consent model, approvals cover only policy and authority changes (not individual actions), audit is not tamper-evident. **Risk:** pins `@appport/core` 1.0.2, while AppPort is at 1.7.1 (`package.json:105`). |
| **Resolver** | Outcome intent → questions, requirements, plans | `ref://` reference resolver: maps a name to the current value, secret, model, endpoint or agent target, with revisions, weighted/failover bindings and grants. Durable on FeltDB with conditional writes. *code+test* (199 cases). No planning, question or requirement code. | **Name collision; wrong role** | Use as-is for what it is: resolving which provider endpoint or secret a capability uses at run time. The spec's "Resolver" role must be **new code** with another name (suggested: *intake*). |
| **AppBoundry** | Product orchestration and lifecycle (intake → quote → order → delivery) | Artifact host/runtime plus capability catalog, resolution, entitlements, composition, materialization, execution ledger and provider lifecycle (`packages/appboundry-runtime/src/*`, tests pr71–pr88). Payment capabilities are catalog schemas only. "Order-to-cash" exists only as a mock-provider test (`packages/cli/test/pr83-business-workflow.test.ts`). | **Wrong layer; useful below** | It sits **under** products, not above them. Closest existing match for spec §11/§16 (capability registry, composition, plan resolution). Candidate home for `PlanCompiler` and the capability catalog, once verified in depth (most runtime packages are private 0.1.0). |
| **PAX** | Durable execution and coordination, transitions, recovery | Stateless Rust CLI that observes projects (JS, Python, Rust, Docker) and delegates build/test/run to native tools. "PAX does not hold state" and deliberately excludes retries, repair and goal evaluation (`docs/PAX_BOUNDARY.md`, numbered item 4 and "Deliberately outside PAX"). | **Contradicted** | Not part of the order runtime. It could at most supply *evidence* for software-delivery outcomes. Answers §26 Q2: PAX is **neither** the execution source of truth nor a work-representation layer. |
| **Intent** | Customer goal, service request, approval, change of scope | FeltDB `IntentService`: an app-development planner. `Intent{raw_request, action: implement\|extend\|transition, target: module\|billing\|state, ambiguities, plan, proposal_id}` stored in `_feltdb.Intent` (`@feltdb/core` `dist/intent.d.ts:5-33`). Deployed as a stateless `boundry-intent` container (`appboundry/deploy/boundry`). Not a product (`boundry/content/products.json`). | **Name collision; wrong role** | Do not reuse. A customer outcome request needs its own entity (suggested: `OutcomeRequest`) to avoid two meanings of "Intent" in one ecosystem. The `ambiguities` / `requires_selection` pattern is worth copying for intake. |
| **FeltKit** | Shared types, codecs, event envelopes, client tooling | A full application platform (`@feltdb/feltkit` 0.3.27): server, client, React, CLI, dashboard; tenants and sessions; `FeltDbIdempotencyStore`; transactional outbox `ctx.afterCommit`; **person-only approvals bound to the sha256 digest of the exact operation and input, with expiry and re-checked authority at execution** (`runtime/approval-rules.ts:1-25`, *code+test*); agent action lifecycle with compare-and-swap transitions and reconcile on restart (`runtime/agent.ts`); recurring schedules. ~100 test files. No workflow or saga engine. No persisted event envelope (events are ephemeral). | **Wrong role; best host** | The service business itself should be **a FeltKit application**: it already provides tenancy, idempotency, outbox, human checkpoints and scheduled recurrence on FeltDB. |

Also relevant, not in the spec's map:

| Component | Relevance |
|---|---|
| **resolver-control** (FeltKit app) | The only shipped *propose → impact → approve → execute → verify* flow with reconcile-from-history recovery (`component/engine.ts:171-194`, 35 test cases). This is the closest working precedent for "a step pauses for a person, then executes exactly once". |
| **boundry-intel** (this repo) | `boundry.event/1` is a cross-product *evidence-that-something-happened* envelope with `correlationId`, but no `causationId`, `tenantId` or aggregate version. It suits order lifecycle *telemetry*. It is **not** the order event store, and acceptance stores envelopes verbatim and derives nothing. The registry's provenance model (`reference` vs `observation`, `assertedBy`, `observedAt`/`recordedAt`) is a tested pattern the evidence graph (§13) can reuse. |

## 3. Open decisions (§26) the code answers

| §26 question | Answer from evidence |
|---|---|
| Which repos are authoritative per component? | Table in §2. FeltDB source is unread; its facts are from the published 0.21.0 package. |
| Is PAX the execution source of truth, a representation layer, or both? | **Neither.** PAX is stateless by declared boundary and in code. |
| What FeltDB guarantees exist? | Atomic conditional transactions, unique and reference constraints, content-addressed blobs, rebuildable snapshots: yes. Native append-only: no. Row-level tenancy: no. Remote/managed runtime: unverified in this ecosystem. |
| How are Intent and Resolver modelled; what compatibility follows? | Both names are taken by components with unrelated meanings. Compatibility requires **not** reusing either name for customer intake. |
| What actions always require human approval? | Still a policy decision, but the mechanism exists: FeltKit digest-bound approvals. AuthBoundry cannot yet express a per-action approval requirement. |

Still open (the code cannot answer them): the first outcome and connector; commercial treatment of failure and
partial delivery; the payment adapter (no real payment integration exists anywhere); customer-safe evidence;
retention and residency obligations; which FeltDB authority hosts production.

## 4. Where the spec should change

1. **§3 / §18 architecture.** Replace "Intent + Resolver → plan" and "PAX / orchestration" with: *FeltKit app
   (intake, quote, order, delivery) → AppPort capabilities → AuthBoundry delegations → FeltDB facts*, with the
   AppBoundry runtime as the candidate capability catalog and plan resolver. Introduce no new runtime until one
   outcome works end to end.
2. **§11 orchestration.** No durable workflow runtime exists in the stack. For the MVP's single fulfillment path,
   FeltKit's agent action lifecycle (compare-and-swap transitions, reconcile on restart) and outbox are sufficient
   and already tested. Choose Temporal or similar only when Phase 2 needs timers, compensation or fan-out the
   lifecycle cannot express. That is the spec's own §27.8 rule.
3. **§7 / §12 authority.** Specify a grant as an AuthBoundry delegation with `resource_scope` and `expires_at`.
   Purpose binding and per-action approval enforcement are **new work** in AuthBoundry. Until then, purpose is
   recorded on the order-side grant record and approval is enforced by FeltKit approvals.
4. **§13 evidence.** "Immutable" means append-only by convention (`requireAbsent` writes plus digests). Nothing in
   the stack is tamper-evident. Either accept that or make hash-chaining an explicit Phase 2 item.
5. **§15 tenancy.** Spec acceptance test 13 (tenant isolation) can only be met today with a FeltDB namespace per
   tenant, or with tenant checks in application code plus AuthBoundry `TenantCurrent`. Row-level isolation in FeltDB
   is not implemented.
6. **§20 events.** `OrderAccepted` is listed twice with two meanings (the order accepted for fulfillment, and the
   customer accepting the delivery). Rename one, e.g. `OrderAcceptedForFulfillment` and `DeliveryAccepted`.
7. **§16 cost.** AppPort capabilities carry no cost or usage dimensions. Quoting needs a declared cost model, either
   as an AppPort manifest extension or held by the product. Decide before Phase 2.

## 5. Risks found during the inventory

- AuthBoundry ↔ AppPort version drift (1.0.2 vs 1.7.1), and AuthBoundry's TS adapter exists only as `dist`, with no
  checked-in source.
- FeltDB managed/remote mode is unverified, and production for this repo runs embedded local.
- Most AppBoundry runtime packages are private 0.1.0. The capability catalog's suitability as `PlanCompiler` is
  plausible, not verified.
- The ecosystem docs (`boundry/content/stack.json`) describe Intent as "deterministic execution", while the code is a
  stateless planner. The docs disclaim operational verification. Treat them as positioning, not as a specification.

## 6. Next step (spec §27.2)

Freeze the first service contract and its acceptance tests before any fulfillment code. That requires choosing the
first outcome and its one read-only connector (an owner decision). The product should live in its own repository as
a FeltKit application, not inside boundry-intel, whose scope is the ecosystem registry and event acceptance.
