import assert from 'node:assert/strict';
import test from 'node:test';

import { createFeltDB } from '@feltdb/core';

import { COLLECTIONS, REGISTRY_CONTRACT, RegistryStore, recordKey, registryIdOf } from '../src/index.mjs';
import { docs, harness, observation, provenance } from './support.mjs';

const REPO = 'repository:github.com/rkendel1/flow_db';

test('identity: a document is recorded once, under its derived id, with the registry clock as recordedAt', async () => {
  const h = await harness({ now: () => new Date('2026-11-09T12:00:00Z') });
  try {
    const sent = docs.product();
    const result = await h.store.assert(sent);
    assert.deepEqual({ status: result.status, id: result.id, revision: result.revision }, { status: 'recorded', id: 'product:feltdb', revision: 1 });
    assert.match(result.digest, /^sha256:[0-9a-f]{64}$/);
    const stored = await h.store.get('product:feltdb');
    assert.deepEqual(stored.document, { ...sent, id: 'product:feltdb', provenance: { ...sent.provenance, recordedAt: '2026-11-09T12:00:00.000Z' } }, 'the assertion as sent, plus the derived id and recordedAt');
    assert.deepEqual({ kind: stored.kind, revision: stored.revision, digest: stored.digest, recordedAt: stored.recordedAt }, { kind: 'product', revision: 1, digest: result.digest, recordedAt: '2026-11-09T12:00:00.000Z' });
    assert.equal(await h.store.get('product:unknown'), null);
    // The FeltDB record id is a digest of the registry id (FeltDB ids cannot carry ':' or '/'), and the readable id is unique.
    const raw = await h.db.collection(COLLECTIONS.records).get(recordKey('product:feltdb'));
    assert.equal(raw.registryId, 'product:feltdb');
    assert.deepEqual(REGISTRY_CONTRACT.collections[COLLECTIONS.records].unique, [['registryId']]);
  } finally {
    await h.close();
  }
});

test('idempotency: re-asserting the same document is unchanged and writes nothing, whatever the member order', async () => {
  const h = await harness();
  try {
    const sent = docs.repository();
    const first = await h.store.assert(sent);
    assert.equal(first.status, 'recorded');
    const before = await h.store.get(REPO);
    const reordered = { provenance: sent.provenance, visibility: sent.visibility, defaultBranch: sent.defaultBranch, name: sent.name, owner: sent.owner, host: sent.host, kind: sent.kind, schema: sent.schema };
    const again = await h.store.assert(reordered);
    assert.deepEqual(again, { status: 'unchanged', id: REPO, digest: first.digest, revision: 1 });
    assert.deepEqual(await h.store.get(REPO), before, 'nothing changed, not even recordedAt');
    assert.deepEqual((await h.store.assertAll([sent, sent])).map((r) => r.status), ['unchanged', 'unchanged']);
  } finally {
    await h.close();
  }
});

test('conflict: the same id with different content is refused and the recorded document stands', async () => {
  const h = await harness();
  try {
    const recorded = await h.store.assert(docs.product());
    const conflict = await h.store.assert(docs.product({ name: 'FeltDB Enterprise' }));
    assert.equal(conflict.status, 'conflict');
    assert.deepEqual(conflict.issues.map((i) => i.code), ['registry.id.reused']);
    assert.equal(conflict.current.digest, recorded.digest, 'the answer carries what is recorded, so the caller can revise');
    assert.equal((await h.store.get('product:feltdb')).document.name, 'FeltDB');
    // Different provenance for the same content is also a different assertion.
    const reasserted = await h.store.assert(docs.product({ provenance: observation({ assertedBy: { type: 'job', id: 'nightly-sync' } }) }));
    assert.equal(reasserted.status, 'conflict');
  } finally {
    await h.close();
  }
});

test('revision: a compare-and-set replacement keeps the superseded version with its provenance', async () => {
  let now = new Date('2026-11-09T12:00:00Z');
  const h = await harness({ now: () => now });
  try {
    const first = await h.store.assert(docs.product());
    now = new Date('2026-11-10T09:00:00Z');
    const stale = await h.store.revise(docs.product({ name: 'FeltDB (renamed)' }), { expectedDigest: 'sha256:' + '0'.repeat(64) });
    assert.equal(stale.status, 'conflict');
    assert.deepEqual(stale.issues.map((i) => i.code), ['registry.digest.stale']);
    const revised = await h.store.revise(docs.product({ name: 'FeltDB (renamed)', provenance: observation({ observedAt: '2026-11-10T08:00:00Z', assertedBy: { type: 'job', id: 'nightly-sync' } }) }), { expectedDigest: first.digest });
    assert.deepEqual({ status: revised.status, revision: revised.revision }, { status: 'revised', revision: 2 });
    const current = await h.store.get('product:feltdb');
    assert.deepEqual({ name: current.document.name, revision: current.revision, recordedAt: current.recordedAt, assertedBy: current.document.provenance.assertedBy }, { name: 'FeltDB (renamed)', revision: 2, recordedAt: '2026-11-10T09:00:00.000Z', assertedBy: { type: 'job', id: 'nightly-sync' } });
    const history = await h.store.history('product:feltdb');
    assert.deepEqual(history.map((r) => [r.revision, r.document.name, r.digest, r.recordedAt]), [[1, 'FeltDB', first.digest, '2026-11-09T12:00:00.000Z'], [2, 'FeltDB (renamed)', revised.digest, '2026-11-10T09:00:00.000Z']]);
    assert.equal(history[0].supersededAt, '2026-11-10T09:00:00.000Z');
    assert.deepEqual(history[0].document.provenance.assertedBy, { type: 'operator', id: 'test-operator' }, 'the old provenance survives');
    // Revising with the same content is unchanged; revising with the old digest again is stale; revising the unknown is missing.
    assert.equal((await h.store.revise(docs.product({ name: 'FeltDB (renamed)', provenance: observation({ observedAt: '2026-11-10T08:00:00Z', assertedBy: { type: 'job', id: 'nightly-sync' } }) }), { expectedDigest: revised.digest })).status, 'unchanged');
    assert.equal((await h.store.revise(docs.product({ name: 'Third' }), { expectedDigest: first.digest })).status, 'conflict');
    assert.equal((await h.store.revise(docs.product({ productId: 'nothing', name: 'x' }), { expectedDigest: first.digest })).status, 'missing');
    assert.equal((await h.store.revise(docs.product({ name: '' }), { expectedDigest: revised.digest })).status, 'rejected');
    assert.deepEqual(await h.store.history('product:nothing'), []);
  } finally {
    await h.close();
  }
});

test('rejections: invalid documents and dangling relationships write nothing', async () => {
  const h = await harness();
  try {
    const invalid = await h.store.assert(docs.product({ productId: 'Not Valid' }));
    assert.deepEqual([invalid.status, invalid.issues[0].code], ['rejected', 'registry.product.invalid']);
    assert.deepEqual((await h.store.list()).records, []);
    await h.store.assert(docs.repository());
    const dangling = await h.store.assert(docs.relationship('repository-of', REPO, 'product:feltdb', { role: 'primary' }));
    assert.deepEqual([dangling.status, dangling.issues[0].code, dangling.issues[0].pointer], ['rejected', 'registry.relationship.dangling', '/to']);
    assert.deepEqual((await h.store.list({ kind: 'relationship' })).records, []);
    const fromMissing = await h.store.assert(docs.relationship('provides', 'product:feltdb', 'capability:collections.query@1'));
    assert.deepEqual([fromMissing.status, fromMissing.issues[0].pointer], ['rejected', '/from']);
    // Once the product exists the same relationship is recorded; an event reference needs no record.
    await h.store.assert(docs.product());
    assert.equal((await h.store.assert(docs.relationship('repository-of', REPO, 'product:feltdb', { role: 'primary' }))).status, 'recorded');
    assert.equal((await h.store.assert(docs.relationship('evidenced-by', 'product:feltdb', 'event:feltdb:evt_00000001', { eventType: 'product.used' }, { provenance: observation({ source: { system: 'boundry.event' } }) }))).status, 'recorded');
    // An entity a relationship names cannot be deleted underneath it: FeltDB's reference constraint holds.
    await assert.rejects(h.db.collection(COLLECTIONS.records).delete(recordKey('product:feltdb')), /still referenced/);
  } finally {
    await h.close();
  }
});

test('provenance is preserved exactly: reference and observation documents keep every field as asserted', async () => {
  const h = await harness({ now: () => new Date('2026-11-09T12:00:00Z') });
  try {
    const reference = docs.version({ provenance: provenance({ source: { system: 'product-repository', locator: 'https://github.com/rkendel1/flow_db/releases/tag/v0.21.0' }, assertedBy: { type: 'integration', id: 'release-sync' }, observedAt: '2026-11-01T00:05:00Z' }) });
    const observed = docs.capability({ provenance: observation({ source: { system: 'boundry.event' }, assertedBy: { type: 'product', id: 'feltdb' }, observedAt: '2026-11-08T23:59:59Z' }) });
    await h.store.assertAll([reference, observed]);
    const v = await h.store.get(registryIdOf(reference));
    assert.deepEqual(v.document.provenance, { ...reference.provenance, recordedAt: '2026-11-09T12:00:00.000Z' });
    assert.equal(v.document.provenance.kind, 'reference');
    const c = await h.store.get(registryIdOf(observed));
    assert.deepEqual(c.document.provenance, { ...observed.provenance, recordedAt: '2026-11-09T12:00:00.000Z' });
    assert.equal(c.document.provenance.kind, 'observation');
    // The indexed projection fields agree with the document.
    const raw = await h.db.collection(COLLECTIONS.records).get(recordKey(v.id));
    assert.deepEqual({ provenanceKind: raw.provenanceKind, sourceSystem: raw.sourceSystem, assertedBy: raw.assertedBy, observedAt: raw.observedAt, productId: raw.productId }, { provenanceKind: 'reference', sourceSystem: 'product-repository', assertedBy: 'integration:release-sync', observedAt: '2026-11-01T00:05:00Z', productId: 'feltdb' });
  } finally {
    await h.close();
  }
});

test('durability: records and the contract survive closing and reopening the FeltDB', async () => {
  const h = await harness();
  const path = h.path;
  try {
    await h.store.assertAll([docs.product(), docs.repository(), docs.relationship('repository-of', REPO, 'product:feltdb', { role: 'primary' })]);
  } finally {
    await h.close({ keep: true });
  }
  const db = createFeltDB({ mode: 'local', namespace: 'boundry-intel-registry', path, access: 'shared' });
  try {
    assert.equal(await RegistryStore.prepare(db), false, 'the contract is already active');
    const store = new RegistryStore(db);
    assert.equal((await store.get('product:feltdb')).document.name, 'FeltDB');
    assert.equal((await store.relationships({ to: 'product:feltdb' })).length, 1);
    assert.equal((await store.assert(docs.product())).status, 'unchanged');
  } finally {
    await db.close();
  }
});

test('the FeltDB contract refuses what the store does not declare', async () => {
  const h = await harness();
  try {
    await assert.rejects(h.db.transaction({ operations: [{ collection: COLLECTIONS.records, id: 'reg_x', requireAbsent: true, value: { id: 'reg_x', registryId: 'x', kind: 'product', surprise: 1 } }] }), /unknown field|missing required/);
    await assert.rejects(h.db.transaction({ operations: [{ collection: 'registry_notes', id: 'n1', requireAbsent: true, value: { id: 'n1' } }] }));
    assert.equal((await h.store.list()).records.length, 0);
  } finally {
    await h.close();
  }
});
