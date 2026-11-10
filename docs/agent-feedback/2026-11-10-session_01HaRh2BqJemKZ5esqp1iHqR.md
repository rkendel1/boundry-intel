# Session `session_01HaRh2BqJemKZ5esqp1iHqR` — 2026-11-09 / 2026-11-10

Agent: Claude Code. Work in this session: FeltKit dependency alignment and the exhaustive CLI composition validation
harness, FeltKit schema-valued identity claims, the resolver-client AppPort 1.7 alignment, and the Boundry Intel
registry and integration contracts. Envelopes:
[`2026-11-10-session_01HaRh2BqJemKZ5esqp1iHqR.events.jsonl`](2026-11-10-session_01HaRh2BqJemKZ5esqp1iHqR.events.jsonl).

Eight entries. Three were defects in FeltKit that the Level B runtime proof exposed and that are now fixed; one is the
open dependency-graph blocker; four are places where a product behaved correctly but not the way its surface implied.

## Entries

### fb_20261110_0001 — generated tests could not pass when workspace creation is closed

`feltkit` 0.3.18 · `sdk_defect` · **high** · fixed in this session

An application composed with `workspace.tenancy.create=none` and any entity got generated domain and files tests that
call `tenancy.create`. The runtime refuses that call by the very declaration the composer had just written, so the
application's own test suite could not pass on a freshly created project. The runtime has no operator path to
provision a workspace, which is correct; the test harness had no path either, which was the gap.

Fixed by giving the harness `createTestApp().provisionTenant`, stated as a test-only provisioning path, and having the
generator use it when creation is closed. Found by Level B case `c_000ee82b781c1c` — not by any scenario test, because
no scenario crossed closed creation with entities.

**What it says about the product.** The composer could write a declaration whose consequences for the generated tests
it did not then honour. The fix is right, but the class of defect is "two generated artifacts disagree", and only an
exhaustive cross product finds those.

### fb_20261110_0002 — a repeated field or relationship name across flags was accepted

`feltkit` 0.3.18 · `sdk_defect` · **medium** · fixed in this session

`--field` and `--ref` were parsed one flag at a time, each correctly refusing a repeat within itself, and the merge did
not check across them. Passing the same name in two flags produced a collection with a duplicate key. Fixed by
refusing a cross-flag repeat with the same message as the within-flag repeat. Found by the invalid case *field
declared twice*.

**What it says about the product.** Validation lived in the parser rather than at the boundary where the whole
selection is known. Worth checking whether other multi-value flags have the same shape.

### fb_20261110_0003 — reconciliation counted an SDK default as the application's own addition

`feltkit` 0.3.18 · `unexpected_behavior` · **high** · fixed in this session

`feltkit({...})` enables `services.notifications` by itself when account e-mail is configured. The reconciler treated
that default as the application's own extension whenever the foundation already had a `services` key, so a later
`compose plan --include services.notifications` came back `REVIEW_REQUIRED` with a reason that was not true:
"feltkit/app.ts extends services.notifications". The application had done no such thing.

This is the entry I would most want a product owner to read, because the refusal was not wrong about *whether* to stop
— it was wrong about *why*, and a developer following the stated reason would have gone looking in their own code for
something that was not there. A wrong reason is worse than a bare refusal.

Fixed by setting aside what the SDK adds to the bare foundation with the same value (`sdkImplied`) while still
reporting the application's genuine additions. Found by the Level B `--evolution` step against the installed package,
case `c_0001dc55be65a2`.

### fb_20261110_0004 — a clean consumer gets two copies of the AppPort packages

`resolver-client` 0.2.2 · `integration_problem` · **high** · open, awaiting publication

`@appport/resolver-client` 0.2.2 is a dependency of the FeltKit SDK and pins `@appport/sdk` 1.6.0, while the SDK pins
1.7.0. npm installs both chains, so a developer's project gets two copies of `@appport/sdk`, `core`, `protocol`,
`schema`, `authorization`, `server`, `mcp`, `client`, the transports and `mobile`.

The FeltKit monorepo hides this with a root `overrides` entry, and npm honours overrides only in the root project, so
`npm ls` in the monorepo shows one copy while a clean consumer gets two. The consumer gate reports it and fails, which
is the gate doing its job.

**Why it is still open.** resolver-client 0.2.3 depends on `@appport/sdk` ^1.7.0 and is prepared but not published.
Until it is, the gate stays red and the override stays. The entry closes when a clean consumer resolves one coherent
graph from the registry with no override present.

**What it says about the ecosystem.** A monorepo override is a local anaesthetic. It made the symptom invisible in the
place most likely to be looked at, and only an install outside the workspace could see the real graph. Any future
override should come with a gate that proves what a consumer actually gets.

### fb_20261110_0005 — one application contract per store, discoverable only by trying

`feltdb` 0.21.0 · `documentation_ambiguity` · **medium** · correct behaviour; recorded

Three independent modules wanted their own FeltDB state contract. Evolving a second one is refused
(`this store is governed by contract …; it cannot be replaced by …`), and writing a collection the active contract does
not declare is refused too. Both refusals are right, and the single-contract rule is the better design: it is what
makes the authority's enforcement complete rather than per-module.

What was missing is that nothing said so before the attempt. The rule was found by writing code that assumed the
opposite, then reading the refusal. Boundry Intel now composes one application contract from three modules'
collections and asserts both refusals as tests, so the next reader learns it from a passing test instead of a failure.

**Severity is medium, not low, because the wrong assumption is the natural one**: a module that owns its collections
looks like it should own their declaration.

### fb_20261110_0006 — `feltkit --version` prints the banner

`feltkit` 0.3.18 · `api_friction` · **low** · recorded, not changed

`feltkit version` prints the version; `feltkit --version` prints the banner. Every other CLI in the toolchain accepts
the flag, so an automated check that asks for `--version` gets prose. The consumer verification uses the subcommand.
Not changed, because changing CLI surface is out of scope for a validation harness, but it is the kind of thing a
script hits first.

### fb_20261110_0007 — a package root cannot be resolved through its `package.json` under export maps

`feltkit` 0.3.18 · `api_friction` · **low** · worked around

`require.resolve('<pkg>/package.json')` throws for packages whose export map does not list `./package.json`, which is
now most of them. Two separate verification scripts — the composition matrix consumer and the resolver dependency
test — both hit it, and both now resolve package roots through `resolve.paths` plus a directory check.

Recorded because it is a trap for any future install-verification code in this ecosystem, and because the obvious
approach fails in a way that looks like a missing dependency rather than a resolution policy.

### fb_20261110_0008 — `history()` returns the current revision as well as the superseded ones

`boundry-intel` 0.1.0 · `documentation_ambiguity` · **low** · correct behaviour; recorded

`RegistryStore.history(id)` returns every revision including the current one. That is the more useful contract, and
the test that failed was mine for assuming otherwise. Recorded only because "history" reads as "what it used to be",
and because three of my assumptions about this store were wrong in the same hour: `product.version` is required in an
event envelope, `product.released` requires `data`, `supersededAt` is normalized to `.000Z`, and
`context.correlationId` has an eight-character minimum. None is a defect; all four are now pinned by tests. The README
states what `history` returns.

## Session notes (not product feedback, no envelope)

**A stacked pull request merged into its base after the base had already merged, so the work never reached `main`.**
Boundry Intel #2 was opened with #1's branch as its base because #1 was still open. #1 merged at 04:32Z; #2 merged at
04:48Z — into the already-merged base branch, which is now two commits ahead of `main`. Nothing is lost and no code is
wrong, but `main` does not have the integration contracts, and CI never ran on the merge result because pushes only
trigger it on `main`. CodeRabbit also skipped its review, by its own comment, because the base was not the default
branch.

This is a workflow hazard rather than a product defect, and the lesson is mechanical: when the base of a stacked pull
request merges, retarget the stacked one to the default branch *before* it is merged. A base branch that has merged is
no longer a base.
