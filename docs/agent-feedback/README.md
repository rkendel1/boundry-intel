# Agent feedback log

Feedback from the agents that build and operate the Boundry ecosystem, recorded per session, starting now rather than
when a pipeline exists.

**Why this is a directory of Markdown and JSONL files and not a service.** The contracts for agent feedback already
exist and are not in question: `appport.feedback/1` supplies the categories, severities, states and disclosure
statuses; `boundry.event/1` supplies the `feedback.submitted` and `feedback.updated` envelopes; `EventAcceptor`
(`src/acceptance.mjs`) stores them durably and idempotently. What is missing is not a contract. It is that nothing
has a path to an acceptor yet, because no FeltDB authority has been chosen (Q1 in
[`../intelligence-evaluation.md`](../intelligence-evaluation.md)), and waiting for that decision would mean throwing
away every observation made between now and then. So the observations are written down, in the contracts' own
vocabulary, in files that a replay can read.

**This is an interim representation, not an authority.** When there is an acceptor to reach, each entry's envelope is
submitted through it and the store becomes the authority; these files stay as the provenance of that submission. They
are not a second feedback store, they do not get their own schema, and nothing reads them to make a decision. If this
directory ever starts being queried, that is the signal to finish the ingestion path instead of growing it here.

## What is recorded

One pair of files per session, named for the date and the session:

| File | Holds |
|---|---|
| `<date>-<session>.md` | the prose: what happened, the evidence, what it cost, and how it was dealt with |
| `<date>-<session>.events.jsonl` | one `boundry.event/1` envelope per line, the machine-readable form of the same entries |

Every envelope is a real, valid `boundry.event/1` event, not a sketch of one. `test/agent-feedback.test.mjs` validates
every line with `validateEvent`, checks that ids are unique, that each prose entry has an envelope and each envelope a
prose entry, and that digests are stable — and then **replays the whole log through the real `EventAcceptor` on a real
FeltDB**: every envelope `accepted`, a second replay every one `duplicate`, and a stored envelope byte-identical to
the line it came from. A log that cannot be replayed is not durable, so CI proves it can be, rather than asserting it.

The replay needs one publisher per product, because a key is bound to one product. That is the isolation boundary
working as designed, not an obstacle: a single credential cannot submit the whole log.

## Entry fields, and where each comes from

| Field | Source | Values |
|---|---|---|
| `data.feedbackId` | this log | `fb_<date>_<nnnn>`; stable forever, referenced by `product.improved` |
| `data.category` | `appport.feedback/1` | `api_friction` `documentation_ambiguity` `missing_capability` `unexpected_behavior` `sdk_defect` `performance_issue` `integration_problem` `security_concern` |
| `data.severity` | `appport.feedback/1` | `low` `medium` `high` `critical` |
| `product.id` | `boundry.registry/1` | the registry product id the feedback is about, so an entry joins the registry |
| `product.version` | the product | the version in hand when the observation was made |
| `occurredAt` | the session | RFC 3339 |
| `context.taskCategory` | `appport.feedback/1` | a namespaced label, never a description |
| `context.integrationMechanism` | `appport.feedback/1` | `appport` `http` `sdk` `mcp` `cli` `other` |
| `actor.agent` | `boundry.event/1` | the agent that reported it, `asserted` (an agent's own claim about itself is never `verified`) |
| `context.correlationId` | the session | the session identifier, so every entry from one session joins |

Severity is about the product, not about how much trouble it caused me. A defect that cost an hour but that no user
can reach is `low`. A refusal that is correct but undiscoverable is `documentation_ambiguity`, not `sdk_defect`.

## Adding entries

Append, never rewrite. An entry's state changes through a `feedback.updated` envelope with the `from` and `to` states
and a `sequence`, exactly as the contract defines; the original entry stays as it was written. Correcting a typo in
the prose is fine; changing what an entry claims happened is a new entry.

An entry is worth writing when the product surprised a competent caller: a refusal with a reason that was not the real
reason, a default that was not what the name implied, a capability that had to be worked around, a document that
described intent as behaviour. An entry is not worth writing for my own mistakes, unless the product made the mistake
easy to make — in which case the entry is about that, and says so.

```bash
npm test                                   # validates every envelope in this directory
```

## Known gap

Nothing aggregates these yet, by design: counting and correlating feedback is a reader's work over stored events, and
there are no stored events until the ingestion path exists. The roadmap item that closes this is "product feedback,
outcome correlation, and improvement loop", which sits after the Boundry Intelligence runtime decision.
