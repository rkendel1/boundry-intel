/**
 * The agent feedback log (`docs/agent-feedback/`) is an interim representation that must stay replayable: when there is
 * an acceptor to reach, every envelope in it is submitted through `EventAcceptor` unchanged. A log that cannot be
 * replayed is not durable, so this test holds it to the contract it claims to be written in — every line a valid
 * `boundry.event/1` event, every id unique, every prose entry matched by an envelope and the reverse.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { FEEDBACK_CATEGORIES, FEEDBACK_SEVERITIES } from '@appport/protocol';

import { eventDigest, validateEvent } from '../src/events.mjs';
import { eventReference, isRegistryId } from '../src/contract.mjs';
import { harness } from './support.mjs';

const dir = fileURLToPath(new URL('../docs/agent-feedback/', import.meta.url));
const logs = readdirSync(dir).filter((f) => f.endsWith('.events.jsonl')).sort();
const read = (file) => readFileSync(new URL(file, new URL('../docs/agent-feedback/', import.meta.url)), 'utf8');

test('there is at least one session log, and every log has its prose', () => {
  assert.ok(logs.length >= 1, 'the feedback log is not empty: collection has started');
  const prose = new Set(readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'README.md'));
  for (const file of logs) assert.ok(prose.has(file.replace('.events.jsonl', '.md')), `${file} has no prose file`);
});

test('every envelope is a valid boundry.event/1 feedback event with a unique, stable identity', () => {
  const seen = new Map();
  for (const file of logs) {
    const lines = read(file).split('\n').filter((l) => l.trim() !== '');
    assert.ok(lines.length > 0, `${file} is empty`);
    for (const [i, line] of lines.entries()) {
      const where = `${file}:${i + 1}`;
      const event = JSON.parse(line);
      const checked = validateEvent(event);
      assert.deepEqual(checked.ok ? [] : checked.issues, [], `${where} is not a valid event`);
      assert.ok(['feedback.submitted', 'feedback.updated'].includes(event.type), `${where}: ${event.type} is not feedback`);
      // The identity the acceptor would store, and the registry reference that names it.
      const reference = eventReference(event.product.id, event.id);
      assert.equal(isRegistryId(reference, ['event']), true, `${where}: ${reference} is not a registry event reference`);
      assert.equal(seen.has(reference), false, `${where}: ${reference} is already used in ${seen.get(reference)}`);
      seen.set(reference, where);
      // A digest over the envelope as written: a replay that changes a byte changes the identity, and this fails.
      assert.match(eventDigest(event), /^sha256:[0-9a-f]{64}$/, where);
      // The vocabularies are the contracts', not this log's.
      if (event.type === 'feedback.submitted') {
        assert.ok(FEEDBACK_CATEGORIES.includes(event.data.category), `${where}: unknown category`);
        assert.ok(FEEDBACK_SEVERITIES.includes(event.data.severity), `${where}: unknown severity`);
      }
      assert.equal(event.actor?.agent?.status, 'asserted', `${where}: an agent's claim about itself is asserted, never verified`);
      assert.ok(typeof event.context?.correlationId === 'string', `${where}: an entry names its session`);
    }
  }
});

test('every envelope has a prose entry and every prose entry an envelope', () => {
  for (const file of logs) {
    const ids = read(file)
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l).data.feedbackId);
    const prose = read(file.replace('.events.jsonl', '.md'));
    const headings = [...prose.matchAll(/^### (fb_[0-9]{8}_[0-9]{4})/gm)].map((m) => m[1]);
    assert.deepEqual(headings, ids, `${file}: prose entries and envelopes must correspond, in order`);
    for (const id of ids) assert.equal(prose.split(`### ${id}`)[1]?.trim().length > 0, true, `${id} has an empty entry`);
  }
});

test('the log replays: every envelope is accepted by the real acceptor, and a second replay is idempotent', async () => {
  const h = await harness();
  try {
    const events = logs.flatMap((file) => read(file).split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l)));
    const byProduct = new Map();
    for (const event of events) {
      if (!byProduct.has(event.product.id)) byProduct.set(event.product.id, []);
      byProduct.get(event.product.id).push(event);
    }
    // A publisher per product, because the acceptor binds a key to one product: the log cannot be replayed under one
    // credential, and that is the isolation boundary working, not an obstacle to route around.
    for (const [productId, batch] of byProduct) {
      const { key } = await h.publishers.issue({ subject: `product:${productId}`, name: `${productId} feedback replay`, scopes: ['events:write'], createdBy: 'operator:replay' });
      const first = await h.events.accept(key, batch);
      assert.deepEqual(first.map((a) => a.status), batch.map(() => 'accepted'), `${productId}: every envelope accepted`);
      const again = await h.events.accept(key, batch);
      assert.deepEqual(again.map((a) => a.status), batch.map(() => 'duplicate'), `${productId}: a second replay writes nothing new`);
    }
    assert.equal(await h.events.count(), events.length, 'one stored event per entry, no more');
    // A replayed entry is stored verbatim: the log is the provenance of the submission, not a lossy summary of it.
    const [sample] = events;
    const stored = await h.events.get(sample.product.id, sample.id);
    assert.deepEqual(stored.event, sample);
    assert.equal(stored.digest, eventDigest(sample));
  } finally {
    await h.close();
  }
});
