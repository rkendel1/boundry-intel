/**
 * `appport.feedback/1` lifecycle changes as `boundry.event/1` envelopes.
 *
 * This is the receiving side of the mapping, and it lives here rather than in AppPort on purpose. AppPort is a
 * protocol and an SDK that stays independent of the systems built on it — its own architecture check enforces that —
 * so it supplies a product-neutral seam (`FeedbackObservation`, `createFeedbackForwarder`) and takes the mapping as
 * an injected function. The envelope shape belongs to `boundry.event/1`, which is defined, validated and accepted
 * here. Putting the mapping beside its contract means every envelope this module produces can be checked against the
 * real validator and handed to the real acceptor, instead of asserted to look right in a repository that cannot
 * check it.
 *
 * **Evidence, not interpretation.** An envelope carries identities, timestamps, provenance and what changed. It
 * carries no summary, no expected or observed text, no reproduction steps and no evidence payload: the product keeps
 * authority over its own records, and this system is told that a change happened, not what it means. Correlation and
 * interpretation are a reader's work over accepted events.
 *
 * **Direction.** AppPort does not depend on this repository; this repository already depends on `@appport/protocol`
 * for the feedback vocabulary that `boundry.event/1` imports. So the mapping adds no new coupling, and the
 * vocabularies need no translation: a category, a severity and a disclosure mean the same on both sides because they
 * come from the same module.
 */
import { digestOf } from '@appport/protocol';

import { EVENT_SCHEMA, eventDigest, validateEvent } from './events.mjs';

/** The extension key the AppPort-side identities travel under: `boundry.event/1` has no field of its own for them. */
export const APPPORT_FEEDBACK_EXTENSION = 'appport.feedback/1';

/**
 * The event identity, and therefore the idempotency key: the feedback record and the sequence of the change within
 * it. A submission is sequence 0, the receipt's own; the nth transition is n.
 *
 * Mapping the same change twice — a forwarder's retry, a replay of a queue, two forwarders watching one provider —
 * gives the same id and the same canonical content, so the acceptor, whose identity is `(product.id, id)`, answers
 * `duplicate` instead of storing it again.
 */
export const feedbackEventId = (feedbackId, sequence) => `feedback.${feedbackId}.${sequence}`;

const defined = (object) => Object.fromEntries(Object.entries(object).filter(([, v]) => v !== undefined));
const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

/**
 * The context of a feedback report, as event context: the correlation id the reporter chose, and each disclosure it
 * made, relayed with its own status. A withheld attribute stays withheld. The mapping never upgrades a disclosure and
 * never invents one the reporter did not make.
 */
const contextOf = (record) => {
  const context = record.report?.context;
  const built = defined({
    correlationId: context?.correlationId,
    runtime: clone(context?.runtime),
    originatingApplication: clone(context?.originatingApplication),
    parentAgent: clone(context?.parentAgent),
    taskCategory: clone(context?.taskCategory),
    integrationMechanism: clone(context?.integrationMechanism),
  });
  return Object.keys(built).length ? built : undefined;
};

/**
 * Who the change is about: the consumer that reported the feedback. The provider authenticated the principal, so it
 * is `verified`; the agent is the reporter's own claim about itself, so it stays `asserted`. The other way round
 * would launder a claim into a fact.
 */
const actorOf = (record) => ({
  principal: { status: 'verified', value: { id: record.owner.id, type: record.owner.type } },
  agent: { status: 'asserted', value: defined({ id: record.claimedAgent?.id, name: record.claimedAgent?.name, version: record.claimedAgent?.version }) },
});

const capabilityOf = (record) => {
  const capability = record.report?.target?.capability;
  if (!capability) return undefined;
  return defined({ name: capability.name, version: capability.version });
};

const extensionOf = (record) => ({
  [APPPORT_FEEDBACK_EXTENSION]: defined({
    product: record.report?.target?.product?.id,
    api: record.report?.target?.api?.version,
    operation: record.report?.target?.operation,
    submissionId: record.report?.submissionId,
  }),
});

/**
 * One durable feedback change as one `boundry.event/1` envelope.
 *
 * A submission becomes `feedback.submitted` with the feedback id, its category and severity, and the report's
 * fingerprint — a grouping hint that is already a digest, not report content. A transition becomes
 * `feedback.updated` with the id, `from`, `to` and the sequence: exactly what changed.
 *
 * A terminal state is **not** a separate event type. `appport.feedback/1` already says which states are terminal and
 * `to` names the state reached, so a `feedback.resolved` would state the same fact in a second place and let the two
 * disagree. `boundry.event/1` has no such type either, and this mapping is not a reason to add one.
 *
 * Timestamps are the product's own — the receipt's `receivedAt` for a submission, the update's `at` for a transition
 * — so a replay long after the fact still says when it happened.
 *
 * @param {{ id: string, version: string }} product the product as the registry knows it: a registry product id, not
 *   the AppPort reverse-domain product id, which travels in the extension because the two grammars differ
 * @param {object} observation an `appport.feedback/1` observation: `{ kind: 'submitted' | 'updated', feedbackId, record, update? }`
 */
export function feedbackEvent(product, observation) {
  const { record } = observation;
  const common = defined({
    schema: EVENT_SCHEMA,
    product: { id: product.id, version: product.version },
    capability: capabilityOf(record),
    actor: actorOf(record),
    context: contextOf(record),
    extensions: extensionOf(record),
  });
  if (observation.kind === 'submitted') {
    const receipt = record.status.receipt;
    return {
      ...common,
      id: feedbackEventId(observation.feedbackId, receipt.sequence),
      type: 'feedback.submitted',
      occurredAt: receipt.receivedAt,
      data: { feedbackId: observation.feedbackId, category: record.report.category, severity: record.report.severity, fingerprint: receipt.fingerprint },
    };
  }
  if (observation.kind !== 'updated') throw new TypeError(`unknown observation kind ${JSON.stringify(observation.kind)}`);
  const update = observation.update;
  return {
    ...common,
    id: feedbackEventId(observation.feedbackId, update.sequence),
    type: 'feedback.updated',
    occurredAt: update.at,
    data: { feedbackId: observation.feedbackId, from: update.from, to: update.to, sequence: update.sequence },
  };
}

/**
 * A mapping to hand to AppPort's `createFeedbackForwarder`, plus the validation that makes it safe to send.
 *
 * An envelope that does not satisfy `boundry.event/1` is **not** forwarded: it is refused here, where the issues can
 * be reported to the product, rather than sent and rejected by the acceptor. A forwarder treats a thrown mapping as
 * that one message lost and carries on, which is the right outcome — a product's feedback must not depend on this
 * system accepting an envelope.
 *
 * ```js
 * import { createFeedbackForwarder } from '@appport/sdk';
 * import { feedbackMapping } from '@boundry/intel-registry';
 *
 * const forwarder = createFeedbackForwarder({ map: feedbackMapping({ id: 'appport-services', version: '0.16.0' }), transport });
 * const feedback = createFeedbackProvider({ ..., observe: forwarder.observe });
 * ```
 */
export function feedbackMapping(product, { now } = {}) {
  if (typeof product?.id !== 'string' || typeof product?.version !== 'string') throw new TypeError('product must be { id, version } as the registry knows it');
  return (observation) => {
    const event = feedbackEvent(product, observation);
    const checked = validateEvent(event, now ? { now: now() } : {});
    if (!checked.ok) {
      const error = new TypeError(`the mapped event is not a valid ${EVENT_SCHEMA}`);
      error.issues = checked.issues;
      throw error;
    }
    return event;
  };
}

/**
 * A transport that hands envelopes straight to an {@link import('./acceptance.mjs').EventAcceptor} with a publisher
 * key. For a process that holds both — a test, an operator's script, a future surface that accepts in-process — so
 * that the forwarder's answers are the acceptor's own, and no network is involved or implied.
 *
 * The answers are translated to the forwarder's vocabulary: `accepted` is `delivered`, `duplicate` stays
 * `duplicate`, and `conflict`, `rejected` and `unauthorized` are all `refused`, because resending any of them cannot
 * help. A storage failure throws, which the forwarder treats as "not yet" and keeps the batch queued.
 */
export function acceptorTransport(acceptor, key) {
  return {
    async deliver(events) {
      const answers = await acceptor.accept(key, [...events]);
      return answers.map((answer) =>
        answer.status === 'accepted'
          ? { status: 'delivered' }
          : answer.status === 'duplicate'
            ? { status: 'duplicate' }
            : { status: 'refused', reason: { status: answer.status, id: answer.id, issues: answer.issues } },
      );
    },
  };
}

export { eventDigest, digestOf };
