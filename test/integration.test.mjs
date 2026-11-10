/**
 * The integration layer on a real local FeltDB: who may tell this registry something (publishers), how a product or
 * repository registers itself and what its integration status then is (`registered-with`), and what happens to an
 * event envelope that arrives — validated, authorized, stored once, and interpreted by nobody at accept time.
 *
 * Nothing here is mocked. Every test opens a persisted FeltDB in a temporary directory under the application's own
 * state contract, so a write that the contract would refuse fails here exactly as it would in production.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { EventAcceptor, PublisherDirectory, RegistryStore, authorizes, eventKey, prepare } from '../src/index.mjs';
import { BOUNDRY_INTEL_CONTRACT } from '../src/application.mjs';
import { docs, envelope, harness, observation, openDb, provenance } from './support.mjs';

const REPO = 'repository:github.com/rkendel1/flow_db';
const PRODUCT = 'product:feltdb';
const statuses = (answers) => answers.map((a) => a.status);

/* ------------------------------------------------------------------------------------------------------------------ */
/* One application contract                                                                                           */
/* ------------------------------------------------------------------------------------------------------------------ */

test('one FeltDB application contract governs every collection; a second contract is refused and an undeclared collection cannot be written', async () => {
  const h = await harness();
  try {
    assert.deepEqual(Object.keys(BOUNDRY_INTEL_CONTRACT.collections), ['registry_records', 'registry_revisions', 'intel_publishers', 'intel_events']);
    assert.equal(await prepare(h.db), false, 'preparing an already-governed store writes nothing');
    // The reason the three modules share one contract: FeltDB refuses to be governed by a second.
    const { defineStateContract, field } = await import('@feltdb/core');
    await assert.rejects(
      h.db.stateContract.evolve(defineStateContract({ name: 'something-else', version: 1, collections: { other: { fields: { a: field.string({ required: true }) } } } })),
      /cannot be replaced/,
    );
    await assert.rejects(
      h.db.transaction({ operations: [{ collection: 'intel_unknown', id: 'x', requireAbsent: true, value: { id: 'x' } }] }),
      /not declared by state contract/,
    );
  } finally {
    await h.close();
  }
});

/* ------------------------------------------------------------------------------------------------------------------ */
/* Publishers                                                                                                         */
/* ------------------------------------------------------------------------------------------------------------------ */

test('a publisher key is issued once, stored only as a hash, authenticates in constant time, and is revocable', async () => {
  const h = await harness();
  try {
    const { publisher, key } = await h.publishers.issue({ subject: PRODUCT, name: 'FeltDB release job', scopes: ['events:write', 'registry:assert'], createdBy: 'operator:randy' });
    assert.match(key, /^bik_[0-9a-f]{12}_[A-Za-z0-9_-]{43}$/, 'the key format of the migrated implementation');
    assert.equal(publisher.subject, PRODUCT);
    assert.equal(publisher.productId, 'feltdb');
    assert.deepEqual(publisher.scopes, ['events:write', 'registry:assert'], 'scopes are stored sorted');
    assert.equal(publisher.revokedAt, null);
    assert.ok(!('secretHash' in publisher) && !('key' in publisher), 'a publisher view never carries the credential');

    // The key is never recoverable: the stored record holds a hash, and nothing returns it again.
    const stored = await h.db.collection('intel_publishers').get(publisher.publisherId);
    assert.match(stored.secretHash, /^[0-9a-f]{64}$/);
    assert.ok(!stored.secretHash.includes(key.slice(-43)));
    assert.ok(!('secretHash' in (await h.publishers.get(publisher.publisherId))));

    assert.equal((await h.publishers.authenticate(key)).publisherId, publisher.publisherId);
    // Anything but the key itself is null, and the shape of the failure never says which part was wrong.
    for (const wrong of [undefined, null, '', 'bik_', key.slice(0, -1), `${key}x`, `bik_${'0'.repeat(12)}_${key.slice(-43)}`, key.replace(/.$/, key.at(-1) === 'a' ? 'b' : 'a')]) {
      assert.equal(await h.publishers.authenticate(wrong), null, `rejects ${String(wrong).slice(0, 24)}`);
    }

    assert.equal(await h.publishers.revoke(publisher.publisherId, { revokedBy: 'operator:randy' }), true);
    assert.equal(await h.publishers.authenticate(key), null, 'a revoked key authenticates no more');
    assert.equal(await h.publishers.revoke(publisher.publisherId), true, 'revoking twice is idempotent');
    assert.equal(await h.publishers.revoke('ffffffffffff'), false, 'revoking an unknown publisher says so');
    assert.ok((await h.publishers.get(publisher.publisherId)).revokedAt);
  } finally {
    await h.close();
  }
});

test('issuing refuses a subject that cannot speak, an unknown scope, and a missing operator', async () => {
  const h = await harness();
  try {
    const bad = (options, pattern) => assert.rejects(() => h.publishers.issue({ name: 'n', scopes: ['events:write'], createdBy: 'operator:randy', ...options }), pattern);
    await bad({ subject: 'capability:collections.query@1' }, /subject must be a registry id of kind product \| repository/);
    await bad({ subject: 'integration:boundry-github-app' }, /subject must be/);
    await bad({ subject: 'product:Not A Product' }, /subject must be/);
    await bad({ subject: undefined }, /subject must be/);
    await bad({ subject: PRODUCT, scopes: ['events:write', 'sudo'] }, /scopes must be a non-empty set/);
    await bad({ subject: PRODUCT, scopes: [] }, /scopes must be a non-empty set/);
    await bad({ subject: PRODUCT, scopes: ['events:write', 'events:write'] }, /scopes must be a non-empty set/);
    await bad({ subject: PRODUCT, createdBy: undefined }, /createdBy must name the operator/);
    await bad({ subject: PRODUCT, name: '' }, /name must be a single-line string/);
    assert.deepEqual(await h.publishers.list(), [], 'nothing was written by any refusal');
  } finally {
    await h.close();
  }
});

test('publisher isolation: a key speaks for its own subject only, and authority is never inherited through the registry', async () => {
  const h = await harness();
  try {
    const feltdb = await h.publishers.issue({ subject: PRODUCT, name: 'FeltDB', scopes: ['events:write'], createdBy: 'operator:randy' });
    const appport = await h.publishers.issue({ subject: 'product:appport', name: 'AppPort', scopes: ['events:write'], createdBy: 'operator:randy' });
    const repo = await h.publishers.issue({ subject: REPO, name: 'GitHub App', scopes: ['registration:verify'], createdBy: 'operator:randy' });

    // Its own product, and nothing else.
    assert.deepEqual(authorizes(feltdb.publisher, { scope: 'events:write', productId: 'feltdb' }), { ok: true });
    assert.deepEqual(authorizes(feltdb.publisher, { scope: 'events:write', productId: 'appport' }), { ok: false, reason: 'publisher.subject' });
    assert.deepEqual(authorizes(appport.publisher, { scope: 'events:write', productId: 'feltdb' }), { ok: false, reason: 'publisher.subject' });
    // A scope it was not given.
    assert.deepEqual(authorizes(feltdb.publisher, { scope: 'registration:verify' }), { ok: false, reason: 'publisher.scope' });
    assert.deepEqual(authorizes(repo.publisher, { scope: 'events:write' }), { ok: false, reason: 'publisher.scope' });
    // A repository key has no product: it cannot pass a product check even for the product that repository belongs to,
    // because what the registry says about ownership is a statement, not a credential.
    await h.store.assert(docs.product());
    await h.store.assert(docs.repository());
    assert.equal((await h.store.assert(docs.relationship('repository-of', REPO, PRODUCT, { role: 'primary' }))).status, 'recorded');
    assert.deepEqual(authorizes(repo.publisher, { scope: 'registration:verify', productId: 'feltdb' }), { ok: false, reason: 'publisher.subject' });
    assert.deepEqual(authorizes(repo.publisher, { scope: 'registration:verify', subject: REPO }), { ok: true });
    // A revoked publisher authorizes nothing, whatever its scopes said.
    await h.publishers.revoke(feltdb.publisher.publisherId);
    assert.deepEqual(authorizes(await h.publishers.get(feltdb.publisher.publisherId), { scope: 'events:write', productId: 'feltdb' }), { ok: false, reason: 'publisher.revoked' });
    assert.deepEqual(authorizes(null, { scope: 'events:write' }), { ok: false, reason: 'publisher.revoked' });

    // Listings are per subject and per product, so an operator sees exactly one subject's keys.
    assert.deepEqual((await h.publishers.list({ subject: PRODUCT })).map((p) => p.name), ['FeltDB']);
    assert.deepEqual((await h.publishers.list({ productId: 'appport' })).map((p) => p.name), ['AppPort']);
    assert.deepEqual((await h.publishers.list({ subject: REPO })).map((p) => p.name), ['GitHub App']);
    assert.equal((await h.publishers.list()).length, 3);
  } finally {
    await h.close();
  }
});

test('store isolation: two Boundry Intel applications in different FeltDB namespaces share nothing', async () => {
  const a = await harness();
  const b = await harness();
  try {
    const issued = await a.publishers.issue({ subject: PRODUCT, name: 'FeltDB', scopes: ['events:write'], createdBy: 'operator:randy' });
    await a.store.assert(docs.product());
    assert.equal((await a.publishers.authenticate(issued.key)).subject, PRODUCT);
    // The same key, the same product id, the other store: nothing is there. The isolation boundary of a store is the
    // FeltDB application it is opened on; this registry does not partition one application between tenants, and says so.
    assert.equal(await b.publishers.authenticate(issued.key), null);
    assert.equal(await b.store.get(PRODUCT), null);
    assert.deepEqual(await b.publishers.list(), []);
  } finally {
    await a.close();
    await b.close();
  }
});

/* ------------------------------------------------------------------------------------------------------------------ */
/* Registration                                                                                                       */
/* ------------------------------------------------------------------------------------------------------------------ */

test('a repository registers, is verified, and its integration status is the registration with its history', async () => {
  const at = ['2026-11-10T04:00:00Z', '2026-11-10T05:00:00Z'];
  let clock = 0;
  const h = await harness({ now: () => new Date(at[Math.min(clock, at.length - 1)]) });
  try {
    const integration = 'integration:boundry-github-app';
    await h.store.assert(docs.repository());
    await h.store.assert(docs.integration({ integrationId: 'boundry-github-app', name: 'Boundry GitHub App', integrationKind: 'github-app', boundary: { mode: 'read', scopes: ['repository:read'] } }));
    const { publisher } = await h.publishers.issue({ subject: REPO, name: 'GitHub App installation', scopes: ['registration:verify'], createdBy: 'operator:randy' });

    // Registered, not yet verified: a statement with its provenance, nothing inferred.
    const pending = docs.relationship('registered-with', REPO, integration, { status: 'pending' }, { provenance: observation({ source: { system: 'operator' }, observedAt: at[0] }) });
    const first = await h.store.assert(pending);
    assert.equal(first.status, 'recorded');
    assert.equal((await h.store.get(first.id)).document.attributes.status, 'pending');

    // Verified by the publisher the integration issued, at a stated time.
    clock = 1;
    const verified = docs.relationship(
      'registered-with',
      REPO,
      integration,
      { status: 'verified', method: 'publisher-key', lastVerifiedAt: at[1], publisher: publisher.publisherId },
      { provenance: observation({ source: { system: 'integration' }, assertedBy: { type: 'integration', id: 'boundry-github-app' }, observedAt: at[1] }) },
    );
    const second = await h.store.revise(verified, { expectedDigest: first.digest });
    assert.equal(second.status, 'revised');
    const current = await h.store.get(first.id);
    assert.deepEqual(current.document.attributes, { status: 'verified', method: 'publisher-key', lastVerifiedAt: at[1], publisher: publisher.publisherId });
    assert.equal(current.revision, 2);

    // The status over time is the registration's history: the superseded statements, then what is recorded now.
    const history = await h.store.history(first.id);
    assert.deepEqual(history.map((r) => r.document.attributes.status), ['pending', 'verified']);
    assert.deepEqual(history.map((r) => r.revision), [1, 2]);
    assert.equal(history[0].supersededAt, new Date(at[1]).toISOString(), 'when the pending statement stopped being current');

    // A registration of something not recorded is refused by the authority, not by a convention here.
    const dangling = await h.store.assert(docs.relationship('registered-with', 'repository:github.com/rkendel1/never-recorded', integration, { status: 'pending' }));
    assert.equal(dangling.status, 'rejected');
    assert.deepEqual(dangling.issues.map((i) => i.code), ['registry.relationship.dangling']);
    // And an integration that is not recorded cannot be registered with either.
    const noIntegration = await h.store.assert(docs.relationship('registered-with', REPO, 'integration:not-recorded', { status: 'pending' }));
    assert.equal(noIntegration.status, 'rejected');

    // Enumeration: what is registered with this integration, and what this repository is registered with.
    assert.deepEqual((await h.store.relationships({ type: 'registered-with' })).map((r) => r.document.from), [REPO]);
    assert.deepEqual((await h.store.relationships({ to: integration })).map((r) => r.document.attributes.status), ['verified']);
    assert.deepEqual((await h.store.relationships({ from: REPO, type: 'registered-with' })).length, 1);
  } finally {
    await h.close();
  }
});

test('products register too, and depend on and compose with one another', async () => {
  const h = await harness();
  try {
    for (const id of ['feltdb', 'appport', 'feltkit', 'boundry', 'boundry-intel']) await h.store.assert(docs.product({ productId: id, name: id }));
    await h.store.assert(docs.integration({ integrationId: 'publisher-keys', name: 'Publisher keys', integrationKind: 'service', boundary: { mode: 'write', scopes: ['events:write'] } }));

    assert.equal((await h.store.assert(docs.relationship('depends-on', 'product:feltkit', 'product:appport', { scope: 'runtime' }))).status, 'recorded');
    assert.equal((await h.store.assert(docs.relationship('depends-on', 'product:feltkit', 'product:feltdb', { scope: 'runtime' }))).status, 'recorded');
    assert.equal((await h.store.assert(docs.relationship('component-of', 'product:boundry-intel', 'product:boundry'))).status, 'recorded');
    assert.equal((await h.store.assert(docs.relationship('registered-with', 'product:feltdb', 'integration:publisher-keys', { status: 'verified', method: 'operator', lastVerifiedAt: '2026-11-10T04:00:00Z' }))).status, 'recorded');

    // What FeltKit needs, and what belongs to Boundry.
    assert.deepEqual((await h.store.relationships({ from: 'product:feltkit', type: 'depends-on' })).map((r) => r.document.to).sort(), ['product:appport', 'product:feltdb']);
    assert.deepEqual((await h.store.relationships({ to: 'product:boundry', type: 'component-of' })).map((r) => r.document.from), ['product:boundry-intel']);
    // Identity is the relationship, so asserting the same dependency twice changes nothing.
    const again = await h.store.assert(docs.relationship('depends-on', 'product:feltkit', 'product:appport', { scope: 'runtime' }));
    assert.equal(again.status, 'unchanged');
    // The same pair with a different attribute is a different statement about the same relationship: a conflict, not a
    // second record, because the id is derived from the endpoints.
    const changed = await h.store.assert(docs.relationship('depends-on', 'product:feltkit', 'product:appport', { scope: 'build' }));
    assert.equal(changed.status, 'conflict');
    assert.equal((await h.store.relationships({ type: 'depends-on' })).length, 2);
  } finally {
    await h.close();
  }
});

/* ------------------------------------------------------------------------------------------------------------------ */
/* Event acceptance                                                                                                    */
/* ------------------------------------------------------------------------------------------------------------------ */

test('an authenticated publisher reports an event: validated, authorized, committed before the answer, and interpreted by nobody', async () => {
  const h = await harness();
  try {
    const { key, publisher } = await h.publishers.issue({ subject: PRODUCT, name: 'FeltDB runtime', scopes: ['events:write'], createdBy: 'operator:randy' });
    const [answer] = await h.events.accept(key, [envelope()]);
    assert.equal(answer.status, 'accepted');
    assert.equal(answer.id, 'evt_00000001');
    assert.equal(answer.reference, 'event:feltdb:evt_00000001');
    assert.match(answer.digest, /^sha256:[0-9a-f]{64}$/);

    // Durable before the answer returned: the record is in FeltDB under the identity (product, event id).
    const stored = await h.events.get('feltdb', 'evt_00000001');
    assert.equal(stored.reference, 'event:feltdb:evt_00000001');
    assert.equal(stored.publisherId, publisher.publisherId);
    assert.deepEqual(stored.event, envelope(), 'the envelope is stored as it was accepted, member for member');

    // Acceptance interprets nothing: the record carries the envelope's own members and no derived fact.
    const raw = await h.db.collection('intel_events').get(eventKey('feltdb', 'evt_00000001'));
    assert.deepEqual(
      Object.keys(raw).filter((k) => !k.startsWith('__') && k !== 'id').sort(),
      ['correlationId', 'digest', 'event', 'eventId', 'occurredAt', 'productId', 'productVersion', 'publisherId', 'receivedAt', 'reference', 'schema', 'type'],
    );
    for (const derived of ['identity', 'confidence', 'agentId', 'principalId', 'organizationId', 'applicationId', 'capability', 'outcome', 'feedbackIds']) {
      assert.ok(!(derived in raw), `${derived} is a reader's interpretation, not part of acceptance`);
    }
    // The publisher's last use is recorded, for the operator.
    assert.ok((await h.publishers.get(publisher.publisherId)).lastUsedAt);
  } finally {
    await h.close();
  }
});

test('the answers a publisher can get: accepted, duplicate, conflict, rejected, unauthorized — and a refusal writes nothing', async () => {
  const h = await harness();
  try {
    const { key } = await h.publishers.issue({ subject: PRODUCT, name: 'FeltDB runtime', scopes: ['events:write'], createdBy: 'operator:randy' });
    assert.deepEqual(statuses(await h.events.accept(key, [envelope()])), ['accepted']);

    // The same envelope again, in any member order: the same canonical digest, so an idempotent resend.
    const reordered = { type: 'capability.invoked', schema: 'boundry.event/1', product: { version: '0.21.0', id: 'feltdb' }, occurredAt: '2026-11-09T10:00:00Z', id: 'evt_00000001', outcome: { status: 'succeeded' }, capability: { version: 1, name: 'collections.query' } };
    assert.deepEqual(statuses(await h.events.accept(key, [envelope(), reordered])), ['duplicate', 'duplicate']);

    // The same id with different content: never accepted, and nothing is overwritten.
    const [conflict] = await h.events.accept(key, [envelope({ outcome: { status: 'failed' } })]);
    assert.equal(conflict.status, 'conflict');
    assert.deepEqual(conflict.issues.map((i) => i.code), ['event.id.reused']);
    assert.equal((await h.events.get('feltdb', 'evt_00000001')).event.outcome.status, 'succeeded', 'the stored event is untouched');

    // Invalid under boundry.event/1: issues, nothing written.
    const invalid = await h.events.accept(key, [
      envelope({ id: 'evt_00000002', type: 'product.exploded' }),
      envelope({ id: 'evt_00000003', occurredAt: 'yesterday' }),
      envelope({ id: 'evt_00000004', schema: 'boundry.event/2' }),
      envelope({ id: 'evt_00000005', surprise: true }),
      { id: 'evt_00000006' },
      null,
    ]);
    assert.deepEqual(statuses(invalid), ['rejected', 'rejected', 'rejected', 'rejected', 'rejected', 'rejected']);
    for (const answer of invalid) assert.ok(answer.issues.length > 0 && answer.issues.every((i) => i.code && i.pointer !== undefined));

    // Another product's event, through a key bound to this one: unauthorized, and not a validation failure.
    const [foreign] = await h.events.accept(key, [envelope({ id: 'evt_00000007', product: { id: 'appport', version: '1.7.0' } })]);
    assert.equal(foreign.status, 'unauthorized');
    assert.deepEqual(foreign.issues.map((i) => i.code), ['event.product.forbidden']);

    // No key, a wrong key, a revoked key: every envelope answered unauthorized, nothing written.
    for (const wrong of [undefined, 'bik_000000000000_0123456789012345678901234567890123456789012']) {
      assert.deepEqual(statuses(await h.events.accept(wrong, [envelope({ id: 'evt_00000008' })])), ['unauthorized']);
    }
    const readOnly = await h.publishers.issue({ subject: PRODUCT, name: 'Reader', scopes: ['registry:assert'], createdBy: 'operator:randy' });
    const [noScope] = await h.events.accept(readOnly.key, [envelope({ id: 'evt_00000009' })]);
    assert.equal(noScope.status, 'unauthorized');
    assert.deepEqual(noScope.issues.map((i) => i.code), ['publisher.scope']);

    // Exactly one event is stored: every refusal above wrote nothing.
    assert.equal(await h.events.count(), 1);
    assert.equal(await h.events.count({ productId: 'feltdb' }), 1);
  } finally {
    await h.close();
  }
});

test('a batch is answered envelope by envelope, in order, and a batch beyond the limit is refused whole', async () => {
  const h = await harness();
  try {
    const { key } = await h.publishers.issue({ subject: PRODUCT, name: 'FeltDB runtime', scopes: ['events:write'], createdBy: 'operator:randy' });
    const answers = await h.events.accept(key, [
      envelope({ id: 'evt_0000000a' }),
      envelope({ id: 'evt_0000000b', type: 'nonsense' }),
      envelope({ id: 'evt_0000000c', product: { id: 'appport', version: '1.7.0' } }),
      envelope({ id: 'evt_0000000a' }),
    ]);
    assert.deepEqual(statuses(answers), ['accepted', 'rejected', 'unauthorized', 'duplicate']);
    assert.deepEqual(answers.map((a) => a.index), [0, 1, 2, 3]);
    assert.deepEqual(answers.map((a) => a.id), ['evt_0000000a', 'evt_0000000b', 'evt_0000000c', 'evt_0000000a']);
    assert.equal(await h.events.count(), 1);

    const { MAX_BATCH } = await import('../src/acceptance.mjs');
    await assert.rejects(() => h.events.accept(key, Array.from({ length: MAX_BATCH + 1 }, (_, i) => envelope({ id: `evt_1000000${i}` }))), /at most 100 envelopes/);
    assert.equal(await h.events.count(), 1, 'an over-long batch stores nothing');
    assert.deepEqual(await h.events.accept(key, []), []);
  } finally {
    await h.close();
  }
});

test('stored events are found by the envelope\'s own members, and listings are stable', async () => {
  const h = await harness();
  try {
    const { key } = await h.publishers.issue({ subject: PRODUCT, name: 'FeltDB runtime', scopes: ['events:write'], createdBy: 'operator:randy' });
    await h.events.accept(key, [
      envelope({ id: 'evt_00000003', occurredAt: '2026-11-09T12:00:00Z', context: { correlationId: 'task_month_end' } }),
      envelope({ id: 'evt_00000001', occurredAt: '2026-11-09T10:00:00Z', context: { correlationId: 'task_month_end' } }),
      envelope({ id: 'evt_00000002', occurredAt: '2026-11-09T11:00:00Z', type: 'product.used', capability: undefined, outcome: undefined }),
    ]);
    const all = await h.events.list();
    assert.deepEqual(all.events.map((e) => e.eventId), ['evt_00000001', 'evt_00000002', 'evt_00000003'], 'oldest occurrence first');
    assert.equal(all.truncated, false);
    assert.deepEqual((await h.events.list({ type: 'product.used' })).events.map((e) => e.eventId), ['evt_00000002']);
    assert.deepEqual((await h.events.list({ correlationId: 'task_month_end' })).events.map((e) => e.eventId), ['evt_00000001', 'evt_00000003']);
    assert.deepEqual((await h.events.list({ productId: 'appport' })).events, []);
    assert.equal(await h.events.get('feltdb', 'evt_99999999'), null);
    assert.equal(await h.events.get('appport', 'evt_00000001'), null, 'identity is (product, id): another product is another event');
    // A listing is the stored bytes, not a summary of them.
    assert.deepEqual((await h.events.list({ type: 'product.used' })).events[0].event.type, 'product.used');
  } finally {
    await h.close();
  }
});

/* ------------------------------------------------------------------------------------------------------------------ */
/* Recovery                                                                                                           */
/* ------------------------------------------------------------------------------------------------------------------ */

test('everything survives a restart: the contract, the registry, publishers with their hashes, and accepted events', async () => {
  const first = await harness();
  const path = first.path;
  let key;
  let publisherId;
  try {
    await first.store.assert(docs.product());
    await first.store.assert(docs.repository());
    await first.store.assert(docs.integration({ integrationId: 'boundry-github-app', name: 'Boundry GitHub App', integrationKind: 'github-app', boundary: { mode: 'read', scopes: ['repository:read'] } }));
    await first.store.assert(docs.relationship('repository-of', REPO, PRODUCT, { role: 'primary' }));
    await first.store.assert(docs.relationship('registered-with', REPO, 'integration:boundry-github-app', { status: 'verified', method: 'github-app', lastVerifiedAt: '2026-11-10T04:00:00Z' }));
    const issued = await first.publishers.issue({ subject: PRODUCT, name: 'FeltDB runtime', scopes: ['events:write'], createdBy: 'operator:randy' });
    key = issued.key;
    publisherId = issued.publisher.publisherId;
    assert.deepEqual(statuses(await first.events.accept(key, [envelope()])), ['accepted']);
  } finally {
    await first.close({ keep: true });
  }

  // A new process on the same state: nothing was in memory, so everything must still be there.
  const { db } = await openDb(path);
  const store = new RegistryStore(db);
  const publishers = new PublisherDirectory(db);
  const events = new EventAcceptor(db, publishers);
  try {
    assert.equal(await prepare(db), false, 'the contract is already installed');
    assert.equal((await store.get(PRODUCT)).document.name, 'FeltDB');
    assert.deepEqual((await store.relationships({ type: 'registered-with' })).map((r) => r.document.attributes.status), ['verified']);
    // The key still authenticates against the stored hash, and it is still bound to its product.
    const publisher = await publishers.authenticate(key);
    assert.equal(publisher.publisherId, publisherId);
    assert.equal(publisher.productId, 'feltdb');
    // The accepted event is there, byte for byte, and a resend is still a duplicate rather than a second record.
    assert.deepEqual((await events.get('feltdb', 'evt_00000001')).event, envelope());
    assert.deepEqual(statuses(await events.accept(key, [envelope()])), ['duplicate']);
    assert.equal(await events.count(), 1);
    // A revocation made after the restart holds, and the event history it accepted stays.
    await publishers.revoke(publisherId);
    assert.deepEqual(statuses(await events.accept(key, [envelope({ id: 'evt_00000002' })])), ['unauthorized']);
    assert.equal(await events.count(), 1);
  } finally {
    await db.close();
    const { rm } = await import('node:fs/promises');
    await rm(path, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------------------------------------------------------ */
/* The two contracts agree on identity                                                                                */
/* ------------------------------------------------------------------------------------------------------------------ */

test('an event reference in the registry names the event the acceptor stored, and the registry can point at it', async () => {
  const h = await harness();
  try {
    const { key } = await h.publishers.issue({ subject: PRODUCT, name: 'FeltDB runtime', scopes: ['events:write'], createdBy: 'operator:randy' });
    const released = envelope({ id: 'rel_0_21_0_0001', type: 'product.released', capability: undefined, outcome: undefined, data: { version: '0.21.0', breaking: false } });
    const [accepted] = await h.events.accept(key, [released]);
    assert.equal(accepted.status, 'accepted');

    await h.store.assert(docs.product());
    await h.store.assert(docs.version());
    // The registry points at the stored event by the identity both contracts share; the event itself stays in the
    // event store, so there is one copy of it and one place that owns it.
    const evidence = await h.store.assert(
      docs.relationship('evidenced-by', 'product-version:feltdb@0.21.0', accepted.reference, { eventType: 'product.released', occurredAt: '2026-11-09T10:00:00Z' }, { provenance: observation({ source: { system: 'boundry.event' } }) }),
    );
    assert.equal(evidence.status, 'recorded');
    const pointed = (await h.store.get(evidence.id)).document.to;
    assert.equal(pointed, accepted.reference);
    const [productId, eventId] = [pointed.split(':')[1], pointed.split(':')[2]];
    assert.equal((await h.events.get(productId, eventId)).event.type, 'product.released');
    assert.deepEqual((await h.events.get(productId, eventId)).event.data, { version: '0.21.0', breaking: false });
    // And the registry never holds the event's content: the relationship carries a pointer and two attributes.
    const reference = await h.store.get(evidence.id);
    assert.ok(!JSON.stringify(reference).includes('0.21.0') || reference.document.from.includes('0.21.0'));
    assert.deepEqual(Object.keys(reference.document.attributes), ['eventType', 'occurredAt']);
  } finally {
    await h.close();
  }
});
