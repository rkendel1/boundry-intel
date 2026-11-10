/**
 * The feedback bridge, end to end: an `appport.feedback/1` lifecycle change becomes a `boundry.event/1` envelope that
 * the real acceptor stores on a real FeltDB.
 *
 * These tests do not assert that an envelope "looks right". They hand every envelope to `validateEvent` and to
 * `EventAcceptor`, which is the only thing that settles whether the mapping is correct: a receiver's answer. The
 * AppPort side of this (the observation seam, the forwarder's queue, bounded drop, retry and counters) is tested in
 * that repository; what is proven here is the mapping and the acceptance.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { APPPORT_FEEDBACK_EXTENSION, acceptorTransport, feedbackEvent, feedbackEventId, feedbackMapping } from '../src/appport-feedback.mjs';
import { eventDigest, validateEvent } from '../src/events.mjs';
import { harness } from './support.mjs';

const PRODUCT = { id: 'appport-services', version: '0.16.0' };
const APPPORT_PRODUCT = 'com.example.invoicing';
const AGENT = { id: 'procurement-agent', name: 'Procurement Agent', version: '4.1.0' };

/** An `appport.feedback/1` record as a provider holds it, with the disclosures a reporter actually makes. */
const record = (o = {}) => ({
  owner: { id: 'svc_procurement', type: 'service' },
  claimedAgent: AGENT,
  report: {
    protocol: 'appport.feedback/1',
    type: 'report',
    submissionId: 'sub_0001',
    submittedAt: '2026-11-09T09:59:00Z',
    target: { product: { id: APPPORT_PRODUCT }, api: { version: '3.2.0' }, capability: { name: 'invoices.create', version: 2 } },
    category: 'unexpected_behavior',
    severity: 'high',
    summary: 'invoices.create@2 rejects ISO dates the schema documents as valid',
    expected: 'dueDate 2026-12-01 is accepted.',
    observed: 'INVALID_INPUT: dueDate must be a string.',
    reproduction: { steps: ['call invoices.create@2 with dueDate 2026-12-01'], errorCode: 'INVALID_INPUT' },
    evidence: [{ id: 'ev_1', kind: 'response', mediaType: 'application/json', digest: `sha256:${'a'.repeat(64)}`, size: 44, content: '{"ok":false,"error":{"code":"INVALID_INPUT"}}', provenance: { source: 'observed' } }],
    reporter: { agent: AGENT },
    context: {
      correlationId: 'task_reconcile_0001',
      runtime: { status: 'asserted', value: { name: 'node', version: '22.11.0' } },
      originatingApplication: { status: 'withheld' },
      parentAgent: { status: 'unavailable' },
      taskCategory: { status: 'asserted', value: 'invoice.creation' },
      integrationMechanism: { status: 'asserted', value: 'sdk' },
    },
    ...o.report,
  },
  status: {
    protocol: 'appport.feedback/1',
    type: 'status',
    feedbackId: o.feedbackId ?? 'fb_00000001',
    submissionId: 'sub_0001',
    state: 'submitted',
    sequence: 0,
    receipt: {
      protocol: 'appport.feedback/1',
      type: 'receipt',
      feedbackId: o.feedbackId ?? 'fb_00000001',
      submissionId: 'sub_0001',
      reportDigest: `sha256:${'b'.repeat(64)}`,
      fingerprint: `sha256:${'c'.repeat(64)}`,
      state: 'submitted',
      sequence: 0,
      receivedAt: '2026-11-09T10:00:00Z',
      correlationId: 'task_reconcile_0001',
    },
    updates: [],
  },
});

const submitted = (o = {}) => ({ kind: 'submitted', feedbackId: o.feedbackId ?? 'fb_00000001', record: record(o) });

/** The lifecycle, as a provider would drive it: each step a real `FeedbackUpdate`. */
const LIFECYCLE = [
  ['submitted', 'acknowledged'],
  ['acknowledged', 'investigating'],
  ['investigating', 'reproduced'],
  ['reproduced', 'accepted'],
  ['accepted', 'in_progress'],
  ['in_progress', 'verified'],
  ['verified', 'released'],
  ['released', 'resolved'],
];

function* lifecycleOf(feedbackId = 'fb_00000001') {
  const base = record({ feedbackId });
  yield { kind: 'submitted', feedbackId, record: base };
  const updates = [];
  for (const [from, to] of LIFECYCLE) {
    const sequence = updates.length + 1;
    const update = { protocol: 'appport.feedback/1', type: 'update', feedbackId, sequence, from, to, at: `2026-11-09T1${sequence}:00:00Z`, actor: { kind: 'agent', id: 'invoicing-maintainer' } };
    updates.push(update);
    const status = { ...base.status, state: to, sequence, updates: [...updates] };
    yield { kind: 'updated', feedbackId, record: { ...base, status }, update, status };
  }
}

test('every mapped envelope is a valid boundry.event/1 event, and the whole lifecycle maps', () => {
  const map = feedbackMapping(PRODUCT);
  const events = [...lifecycleOf()].map(map);
  assert.equal(events.length, 9, 'a submission and eight transitions');
  for (const event of events) {
    const checked = validateEvent(event);
    assert.deepEqual(checked.ok ? [] : checked.issues, [], `${event.id} is not valid`);
  }
  assert.deepEqual(events.map((e) => e.type), ['feedback.submitted', ...LIFECYCLE.map(() => 'feedback.updated')]);
  assert.deepEqual(events.slice(1).map((e) => [e.data.from, e.data.to]), LIFECYCLE);
  assert.deepEqual(events.map((e) => e.data.sequence ?? 0), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  // A terminal state is a transition like any other: no event type is invented for it.
  assert.deepEqual(events.at(-1).data, { feedbackId: 'fb_00000001', from: 'released', to: 'resolved', sequence: 8 });
  // The product's own timestamps, never the mapping's clock, and never going backwards.
  assert.equal(events[0].occurredAt, '2026-11-09T10:00:00Z');
  assert.deepEqual([...events].map((e) => e.occurredAt).sort(), events.map((e) => e.occurredAt));
});

test('identity is stable and content-addressed: the same change maps to the same id and digest, a different one does not', () => {
  const map = feedbackMapping(PRODUCT);
  const [first] = [...lifecycleOf()];
  assert.equal(map(first).id, feedbackEventId('fb_00000001', 0));
  assert.equal(eventDigest(map(first)), eventDigest(map(first)), 'mapping is deterministic');
  // Member order is not identity; content is.
  const reordered = Object.fromEntries(Object.entries(map(first)).reverse());
  assert.equal(eventDigest(reordered), eventDigest(map(first)));
  const [, acknowledged] = [...lifecycleOf()];
  assert.notEqual(map(acknowledged).id, map(first).id);
  assert.notEqual(eventDigest(map(acknowledged)), eventDigest(map(first)));
});

test('provenance crosses exactly: the principal is verified, the agent only asserted, a withheld disclosure stays withheld', () => {
  const event = feedbackEvent(PRODUCT, submitted());
  assert.deepEqual(event.actor, {
    principal: { status: 'verified', value: { id: 'svc_procurement', type: 'service' } },
    agent: { status: 'asserted', value: AGENT },
  });
  assert.deepEqual(event.context, {
    correlationId: 'task_reconcile_0001',
    runtime: { status: 'asserted', value: { name: 'node', version: '22.11.0' } },
    originatingApplication: { status: 'withheld' },
    parentAgent: { status: 'unavailable' },
    taskCategory: { status: 'asserted', value: 'invoice.creation' },
    integrationMechanism: { status: 'asserted', value: 'sdk' },
  });
  // The capability is preserved natively; the AppPort identities travel in the namespaced extension, because the
  // registry's product grammar rejects a reverse-domain name and the two namespaces are not the same.
  assert.deepEqual(event.capability, { name: 'invoices.create', version: 2 });
  assert.deepEqual(event.extensions, { [APPPORT_FEEDBACK_EXTENSION]: { product: APPPORT_PRODUCT, api: '3.2.0', submissionId: 'sub_0001' } });
  assert.equal(event.product.id, PRODUCT.id);
});

test('evidence, not content: nothing a reporter wrote crosses the boundary', () => {
  const serialized = JSON.stringify([...lifecycleOf()].map(feedbackMapping(PRODUCT)));
  for (const content of [
    'invoices.create@2 rejects ISO dates the schema documents as valid',
    'dueDate 2026-12-01 is accepted.',
    'INVALID_INPUT: dueDate must be a string.',
    'call invoices.create@2 with dueDate 2026-12-01',
    '{"ok":false,"error":{"code":"INVALID_INPUT"}}',
  ]) {
    assert.equal(serialized.includes(content), false, `report content leaked: ${content}`);
  }
  // What does cross for a submission: the identity, the classification, and the fingerprint, already a digest.
  assert.deepEqual(feedbackEvent(PRODUCT, submitted()).data, { feedbackId: 'fb_00000001', category: 'unexpected_behavior', severity: 'high', fingerprint: `sha256:${'c'.repeat(64)}` });
});

test('the acceptor stores the whole lifecycle, and a resend is a duplicate rather than a second record', async () => {
  const h = await harness();
  try {
    const { key } = await h.publishers.issue({ subject: `product:${PRODUCT.id}`, name: 'AppPort feedback bridge', scopes: ['events:write'], createdBy: 'operator:test' });
    const events = [...lifecycleOf()].map(feedbackMapping(PRODUCT));

    const first = await h.events.accept(key, events);
    assert.deepEqual(first.map((a) => a.status), events.map(() => 'accepted'), 'every envelope accepted');
    assert.equal(await h.events.count({ productId: PRODUCT.id }), 9);

    // The forwarder's retry after a failed delivery: the same envelopes again.
    const again = await h.events.accept(key, events);
    assert.deepEqual(again.map((a) => a.status), events.map(() => 'duplicate'), 'a resend stores nothing new');
    assert.equal(await h.events.count({ productId: PRODUCT.id }), 9);

    // Stored verbatim: the envelope the product sent, not a reading of it.
    const stored = await h.events.get(PRODUCT.id, events[0].id);
    assert.deepEqual(stored.event, events[0]);
    assert.equal(stored.digest, eventDigest(events[0]));
    // Found by the envelope's own members, and the lifecycle reads back in order.
    const { events: listed } = await h.events.list({ productId: PRODUCT.id, correlationId: 'task_reconcile_0001' });
    assert.deepEqual(listed.map((e) => e.event.data.sequence ?? 0), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
    assert.deepEqual((await h.events.list({ productId: PRODUCT.id, type: 'feedback.submitted' })).events.length, 1);
  } finally {
    await h.close();
  }
});

test('the acceptor transport answers in the forwarder\'s vocabulary, and a refusal is final', async () => {
  const h = await harness();
  try {
    const { key } = await h.publishers.issue({ subject: `product:${PRODUCT.id}`, name: 'bridge', scopes: ['events:write'], createdBy: 'operator:test' });
    const transport = acceptorTransport(h.events, key);
    const events = [...lifecycleOf()].map(feedbackMapping(PRODUCT));

    assert.deepEqual((await transport.deliver(events)).map((a) => a.status), events.map(() => 'delivered'));
    assert.deepEqual((await transport.deliver(events)).map((a) => a.status), events.map(() => 'duplicate'));

    // A conflict is refused, not retried: the same identity with different content cannot be helped by resending.
    const conflicting = { ...events[0], data: { ...events[0].data, severity: 'low' } };
    const [answer] = await transport.deliver([conflicting]);
    assert.equal(answer.status, 'refused');
    assert.equal(answer.reason.status, 'conflict');
    // A key for another product is refused too, and the boundary holds: nothing was stored.
    const other = await h.publishers.issue({ subject: 'product:feltdb', name: 'wrong product', scopes: ['events:write'], createdBy: 'operator:test' });
    const [forbidden] = await acceptorTransport(h.events, other.key).deliver([events[0]]);
    assert.equal(forbidden.status, 'refused');
    assert.equal(forbidden.reason.status, 'unauthorized');
    assert.equal(await h.events.count(), 9, 'a refusal writes nothing');
  } finally {
    await h.close();
  }
});

test('an envelope that would not be accepted is refused by the mapping, before anything is sent', () => {
  const map = feedbackMapping(PRODUCT);
  // A product id the registry's grammar refuses: the AppPort reverse-domain name, which belongs in the extension.
  assert.throws(() => feedbackMapping({ id: APPPORT_PRODUCT, version: '3.2.0' })(submitted()), (error) => error.issues?.some((i) => i.pointer === '/product/id'));
  // An unknown observation kind is a programming error, not an event to send.
  assert.throws(() => map({ kind: 'deleted', feedbackId: 'fb_00000001', record: record() }), /unknown observation kind/);
  // A product that is not { id, version } is refused when the mapping is built, not per event.
  assert.throws(() => feedbackMapping({ id: 'appport-services' }), /product must be/);
});
