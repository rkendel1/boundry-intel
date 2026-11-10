/**
 * The migrated `boundry.event/1` contract, and the one thing that must stay true of it here: an event id and a product
 * id mean the same in `boundry.event/1` and `boundry.registry/1`. The grammars were copied between the two contracts
 * character for character, and this file pins that behaviourally — which is stronger than comparing regular
 * expressions, because it is what a caller actually experiences: the registry can point at exactly the events the
 * acceptor can store, and at no others.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { fromJSONSchema } from '@appport/schema';

import { EVENT_SCHEMA, EVENT_TYPES, SUPPORTED_EVENT_SCHEMAS, eventDigest, validateEvent } from '../src/events.mjs';
import { eventReference, isRegistryId } from '../src/contract.mjs';
import { envelope } from './support.mjs';

const root = JSON.parse(readFileSync(new URL('../schema/boundry-event-1.schema.json', import.meta.url), 'utf8'));
const schema = fromJSONSchema(root.$defs?.event ?? root, root);
const bothAccept = (value) => ({ schema: schema.validate(JSON.parse(JSON.stringify(value))).ok, reference: validateEvent(value).ok });

test('the contract is boundry.event/1 and nothing else, with its vocabulary intact after the migration', () => {
  assert.equal(EVENT_SCHEMA, 'boundry.event/1');
  assert.deepEqual([...SUPPORTED_EVENT_SCHEMAS], ['boundry.event/1']);
  // The nine types the Phase 0 audit enumerated, unchanged by moving repository.
  assert.deepEqual([...EVENT_TYPES], [
    'product.discovered',
    'product.used',
    'capability.invoked',
    'task.completed',
    'task.failed',
    'feedback.submitted',
    'feedback.updated',
    'product.improved',
    'product.released',
  ]);
  assert.equal(validateEvent(envelope()).ok, true);
  assert.equal(validateEvent(envelope({ schema: 'boundry.event/2' })).ok, false);
});

test('a product id means the same thing in both contracts', () => {
  const ids = ['feltdb', 'appport', 'appport-services', 'boundry-intel', 'a1', 'x'.repeat(64), 'x'.repeat(65), 'FeltDB', 'felt_db', 'felt.db', '1feltdb', '-feltdb', '', 'felt db'];
  for (const id of ids) {
    const asEvent = validateEvent(envelope({ product: { id, version: '1.0.0' } })).ok;
    const asRegistry = isRegistryId(`product:${id}`, ['product']);
    assert.equal(asEvent, asRegistry, `product id ${JSON.stringify(id)}: event ${asEvent}, registry ${asRegistry}`);
  }
});

test('an event id means the same thing in both contracts, so the registry points at exactly what the acceptor stores', () => {
  const ids = ['evt_00000001', 'rel_0_21_0_0001', 'a'.repeat(8), 'a'.repeat(128), 'a'.repeat(129), 'short', 'evt:0000:0001', 'evt.00000001', 'evt-00000001', '_evt_0001', 'evt 00000001', ''];
  for (const id of ids) {
    const asEvent = validateEvent(envelope({ id })).ok;
    const asReference = isRegistryId(eventReference('feltdb', id), ['event']);
    assert.equal(asEvent, asReference, `event id ${JSON.stringify(id)}: event ${asEvent}, reference ${asReference}`);
  }
  // And a reference is only ever to an event, never mistaken for an entity.
  assert.equal(isRegistryId(eventReference('feltdb', 'evt_00000001'), ['product', 'repository']), false);
});

test('the published event schema and the reference validator agree', () => {
  const valid = [
    envelope(),
    envelope({ id: 'evt_00000002', type: 'product.used', capability: undefined, outcome: undefined }),
    envelope({ id: 'evt_00000003', type: 'task.completed', capability: undefined, outcome: { status: 'succeeded' }, data: { taskId: 'task_month_end_0042' }, context: { correlationId: 'task_month_end_0042' } }),
    envelope({ id: 'evt_00000004', type: 'product.released', capability: undefined, outcome: undefined, data: { version: '0.21.0', breaking: false } }),
    envelope({ id: 'evt_00000005', counters: { operations: 3, durationMs: 120 } }),
  ];
  for (const [i, event] of valid.entries()) assert.deepEqual(bothAccept(event), { schema: true, reference: true }, `valid #${i} (${event.type})`);

  const invalid = [
    envelope({ type: 'product.exploded' }),
    envelope({ occurredAt: 'yesterday' }),
    envelope({ product: { id: 'feltdb' } }),
    envelope({ surprise: true }),
    envelope({ counters: { operations: -1 } }),
    envelope({ id: 'short' }),
  ];
  for (const [i, event] of invalid.entries()) assert.deepEqual(bothAccept(event), { schema: false, reference: false }, `invalid #${i}`);
});

test('the digest is canonical: member order never changes an event\'s identity, content always does', () => {
  const a = envelope();
  const reordered = { outcome: { status: 'succeeded' }, capability: { version: 1, name: 'collections.query' }, product: { version: '0.21.0', id: 'feltdb' }, occurredAt: '2026-11-09T10:00:00Z', type: 'capability.invoked', id: 'evt_00000001', schema: 'boundry.event/1' };
  assert.equal(eventDigest(a), eventDigest(reordered));
  assert.notEqual(eventDigest(a), eventDigest(envelope({ outcome: { status: 'failed' } })));
  assert.match(eventDigest(a), /^sha256:[0-9a-f]{64}$/);
});
