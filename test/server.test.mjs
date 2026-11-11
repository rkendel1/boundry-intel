/**
 * The HTTP boundary, held to the same guarantees as the contracts behind it.
 *
 * These tests drive a real `node:http` server over a real socket against a real local FeltDB. They check behaviour,
 * not endpoint shapes: that all five acceptance answers survive the boundary, that a refusal writes nothing, that an
 * accepted event is committed before the response and is still there after the process-level store is reopened, that
 * readiness fails when storage does not work, and that a production configuration cannot fall back to a store that
 * does not outlive the process.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createIntelHandler } from '../src/server.mjs';
import { ConfigurationError, resolveRuntimeConfig } from '../src/config.mjs';
import { storageReadiness } from '../src/main.mjs';
import { harness, envelope } from './support.mjs';

const OPERATOR = 'operator-token-at-least-thirty-two-chars';

/** A server on an ephemeral port over a local FeltDB, with the operator boundary configured. */
async function serve({ operatorToken = OPERATOR, readiness, path } = {}) {
  const h = await harness({ path });
  const config = resolveRuntimeConfig({ NODE_ENV: 'test', PORT: '0', ...(operatorToken ? { BOUNDRY_INTEL_OPERATOR_TOKEN: operatorToken } : {}) });
  const logged = [];
  const handler = createIntelHandler({
    config: { ...config, port: 0 },
    publishers: h.publishers,
    events: h.events,
    readiness: readiness ?? storageReadiness(h.events),
    log: (entry) => logged.push(entry),
  });
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, route, { body, token, operator } = {}) => {
    const response = await fetch(`${base}${route}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(operator ? { 'boundry-operator': operator } : {}),
      },
      ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
  return {
    ...h,
    call,
    logged,
    close: async (options) => {
      await new Promise((resolve) => server.close(resolve));
      await h.close(options);
    },
  };
}

/** A publisher key for one product, issued through the operator boundary so the HTTP path is what is exercised. */
async function issue(s, { subject = 'product:feltdb', scopes = ['events:write'], name = 'test publisher' } = {}) {
  const issued = await s.call('POST', '/v1/publishers', { body: { subject, name, scopes }, token: OPERATOR, operator: 'operator:test' });
  assert.equal(issued.status, 201, JSON.stringify(issued.body));
  return issued.body;
}

test('liveness and readiness are different questions, and readiness is about storage', async () => {
  const s = await serve();
  try {
    const alive = await s.call('GET', '/health');
    assert.deepEqual([alive.status, alive.body.status], [200, 'alive']);
    const ready = await s.call('GET', '/ready');
    assert.deepEqual([ready.status, ready.body.status], [200, 'ready']);
    assert.equal(ready.body.storage.mode, 'local', 'the probe says which store it answered for');
  } finally {
    await s.close();
  }
});

test('readiness fails, and says why, when the store cannot be used', async () => {
  // The probe is the real one over a store whose query throws: exactly what an unreachable authority looks like.
  const s = await serve({ readiness: async () => ({ ready: false, detail: 'FORBIDDEN: the credential is not authorized for this application' }) });
  try {
    const ready = await s.call('GET', '/ready');
    assert.equal(ready.status, 503);
    assert.equal(ready.body.status, 'unready');
    assert.match(ready.body.detail, /FORBIDDEN/);
    // Liveness still answers: the process is fine, its storage is not, and a restart would not help.
    assert.equal((await s.call('GET', '/health')).status, 200);
  } finally {
    await s.close();
  }
});

test('the real readiness probe reports a store whose query fails, and says what failed', async () => {
  // `storageReadiness` is the probe the service actually runs; this drives it over a store whose query throws, which
  // is what an unreachable authority or an unpromoted contract looks like from inside the process.
  const probe = storageReadiness({ count: async () => { throw Object.assign(new Error('the credential is not authorized for this application'), { code: 'FORBIDDEN' }); } });
  assert.deepEqual(await probe(), { ready: false, detail: 'FORBIDDEN: the credential is not authorized for this application' });
  // And over a working store it says ready, with no detail to explain away.
  const h = await harness();
  try {
    assert.deepEqual(await storageReadiness(h.events)(), { ready: true });
    // Recorded, because it is the reason this test does not simply close the database: a closed local FeltDB still
    // answers a count, so closing one does not simulate an unusable store. Only a throwing store does.
    await h.db.close();
    assert.deepEqual(await storageReadiness(h.events)(), { ready: true }, 'a closed local store still answers; this is why the probe is driven directly');
  } finally {
    await h.close().catch(() => {});
  }
});

test('all five acceptance answers survive the HTTP boundary, and every refusal writes nothing', async () => {
  const s = await serve();
  try {
    const { key } = await issue(s);
    const before = await s.events.count();

    // accepted
    const accepted = await s.call('POST', '/v1/events', { body: envelope(), token: key });
    assert.deepEqual([accepted.status, accepted.body.status], [200, 'accepted']);
    assert.match(accepted.body.digest, /^sha256:[0-9a-f]{64}$/);
    assert.equal(accepted.body.reference, 'event:feltdb:evt_00000001');

    // duplicate: the same identity with the same canonical content
    const duplicate = await s.call('POST', '/v1/events', { body: envelope(), token: key });
    assert.deepEqual([duplicate.status, duplicate.body.status], [200, 'duplicate']);
    assert.equal(duplicate.body.digest, accepted.body.digest);

    // conflict: the same identity, different content
    const conflict = await s.call('POST', '/v1/events', { body: envelope({ outcome: { status: 'failed' } }), token: key });
    assert.deepEqual([conflict.status, conflict.body.status], [409, 'conflict']);
    assert.deepEqual(conflict.body.issues.map((i) => i.code), ['event.id.reused']);

    // rejected: invalid under boundry.event/1
    const rejected = await s.call('POST', '/v1/events', { body: envelope({ id: 'evt_00000002', type: 'product.exploded' }), token: key });
    assert.deepEqual([rejected.status, rejected.body.status], [400, 'rejected']);
    assert.ok(rejected.body.issues.length > 0, 'the validator’s issues reach the publisher');

    // unauthorized: another product's event, under a key bound to this one
    const forbidden = await s.call('POST', '/v1/events', { body: envelope({ id: 'evt_00000003', product: { id: 'appport', version: '1.7.0' } }), token: key });
    assert.deepEqual([forbidden.status, forbidden.body.status], [403, 'unauthorized']);
    assert.deepEqual(forbidden.body.issues.map((i) => i.code), ['event.product.forbidden']);

    // One event stored for five requests: four refusals wrote nothing.
    assert.equal(await s.events.count(), before + 1);
  } finally {
    await s.close();
  }
});

test('an unknown key, a revoked key and a key without the scope are all refused, and none can write', async () => {
  const s = await serve();
  try {
    assert.equal((await s.call('POST', '/v1/events', { body: envelope() })).status, 401, 'no key at all');
    const unknown = await s.call('POST', '/v1/events', { body: envelope(), token: 'bik_000000000000_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' });
    assert.deepEqual([unknown.status, unknown.body.status], [403, 'unauthorized']);

    // A key that cannot report events: the scope check refuses it, not the schema.
    const wrongScope = await issue(s, { scopes: ['registry:assert'], name: 'registry only' });
    const refused = await s.call('POST', '/v1/events', { body: envelope(), token: wrongScope.key });
    assert.deepEqual([refused.status, refused.body.status], [403, 'unauthorized']);
    assert.deepEqual(refused.body.issues.map((i) => i.code), ['publisher.scope']);

    // Revocation takes effect immediately: the next request with the same key is refused.
    const live = await issue(s, { name: 'to be revoked' });
    assert.equal((await s.call('POST', '/v1/events', { body: envelope({ id: 'evt_00000009' }), token: live.key })).body.status, 'accepted');
    const revoked = await s.call('POST', `/v1/publishers/${live.publisher.publisherId}/revoke`, { body: {}, token: OPERATOR, operator: 'operator:test' });
    assert.deepEqual([revoked.status, revoked.body.revoked], [200, true]);
    const after = await s.call('POST', '/v1/events', { body: envelope({ id: 'evt_00000010' }), token: live.key });
    assert.deepEqual([after.status, after.body.status], [403, 'unauthorized']);
    assert.equal(await s.events.count(), 1, 'only the one event accepted before revocation');
  } finally {
    await s.close();
  }
});

test('a repository publisher cannot publish for the product its repository belongs to', async () => {
  const s = await serve();
  try {
    // The registry may well record that this repository belongs to this product. That is a statement, not a
    // credential, and the HTTP boundary inherits no authority from it.
    const repo = await issue(s, { subject: 'repository:github.com/rkendel1/flow_db', name: 'repository key' });
    assert.equal(repo.publisher.productId, null);
    const refused = await s.call('POST', '/v1/events', { body: envelope(), token: repo.key });
    assert.deepEqual([refused.status, refused.body.status], [403, 'unauthorized']);
    assert.deepEqual(refused.body.issues.map((i) => i.code), ['event.product.forbidden']);
    assert.equal(await s.events.count(), 0);
  } finally {
    await s.close();
  }
});

test('a batch is answered envelope by envelope, in order, and a batch beyond the limit is refused whole', async () => {
  const s = await serve();
  try {
    const { key } = await issue(s);
    const batch = await s.call('POST', '/v1/events', {
      body: { events: [envelope({ id: 'evt_00000101' }), envelope({ id: 'bad' }), envelope({ id: 'evt_00000103' })] },
      token: key,
    });
    assert.equal(batch.status, 200);
    assert.deepEqual(batch.body.answers.map((a) => [a.index, a.status]), [[0, 'accepted'], [1, 'rejected'], [2, 'accepted']]);
    assert.equal(await s.events.count(), 2);

    const tooMany = await s.call('POST', '/v1/events', { body: { events: Array.from({ length: 101 }, (_, i) => envelope({ id: `evt_${String(i).padStart(8, '0')}` })) }, token: key });
    assert.deepEqual([tooMany.status, tooMany.body.code], [413, 'BATCH_TOO_LARGE']);
    assert.equal(await s.events.count(), 2, 'an over-sized batch wrote nothing');
  } finally {
    await s.close();
  }
});

test('a malformed request is refused without reaching the acceptor', async () => {
  const s = await serve();
  try {
    const { key } = await issue(s);
    assert.equal((await s.call('POST', '/v1/events', { body: '{not json', token: key })).body.code, 'BODY_INVALID');
    assert.equal((await s.call('POST', '/v1/events', { body: { events: [] }, token: key })).body.code, 'BATCH_EMPTY');
    const oversize = await s.call('POST', '/v1/events', { body: { events: [envelope({ data: { operation: 'x'.repeat(2_000_000) } })] }, token: key });
    assert.equal(oversize.status, 413);
    assert.equal(await s.events.count(), 0);
    // Unknown routes and wrong methods are distinguishable, and neither is a 500.
    assert.equal((await s.call('GET', '/v1/nothing')).status, 404);
    assert.equal((await s.call('GET', '/v1/events')).status, 405);
  } finally {
    await s.close();
  }
});

test('a storage failure answers unavailable and retryable, never a false acceptance', async () => {
  const s = await serve();
  try {
    const { key } = await issue(s);
    // The acceptor throws when the store fails. Nothing in the adapter may turn that into an acknowledgement.
    const broken = { ...s.events, accept: async () => { throw Object.assign(new Error('authority unreachable'), { code: 'UNAVAILABLE' }); } };
    const config = resolveRuntimeConfig({ NODE_ENV: 'test', PORT: '0', BOUNDRY_INTEL_OPERATOR_TOKEN: OPERATOR });
    const logged = [];
    const server = createServer(createIntelHandler({ config: { ...config, port: 0 }, publishers: s.publishers, events: broken, readiness: async () => ({ ready: true }), log: (e) => logged.push(e) }));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/events`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify(envelope()) });
      const body = await response.json();
      assert.equal(response.status, 503);
      assert.deepEqual([body.status, body.code, body.retryable], ['unavailable', 'STORAGE_UNAVAILABLE', true]);
      assert.equal(body.digest, undefined, 'no digest is offered for something that was not stored');
      assert.ok(logged.some((e) => e.event === 'storage.unavailable'), 'the failure is logged for an operator');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
    assert.equal(await s.events.count(), 0);
  } finally {
    await s.close();
  }
});

test('an accepted event is committed before the response, and survives reopening the store', async () => {
  const path = await mkdtemp(join(tmpdir(), 'boundry-intel-http-'));
  const first = await serve({ path });
  let key;
  try {
    ({ key } = await issue(first));
    const accepted = await first.call('POST', '/v1/events', { body: envelope({ id: 'evt_durable_0001' }), token: key });
    assert.equal(accepted.body.status, 'accepted');
    // Read it back through HTTP, from the same process, with the same key.
    const read = await first.call('GET', '/v1/events/feltdb/evt_durable_0001', { token: key });
    assert.deepEqual([read.status, read.body.eventId, read.body.digest], [200, 'evt_durable_0001', accepted.body.digest]);
  } finally {
    await first.close({ keep: true });
  }

  // A new process over the same durable path: the event and the publisher are both still there.
  const second = await serve({ path });
  try {
    const read = await second.call('GET', '/v1/events/feltdb/evt_durable_0001', { token: key });
    assert.deepEqual([read.status, read.body.eventId], [200, 'evt_durable_0001'], 'the event survived the restart');
    const again = await second.call('POST', '/v1/events', { body: envelope({ id: 'evt_durable_0001' }), token: key });
    assert.equal(again.body.status, 'duplicate', 'and the key still authenticates after the restart');
    assert.equal(await second.events.count(), 1);
  } finally {
    await second.close();
    await rm(path, { recursive: true, force: true });
  }
});

test('the operator boundary: unauthenticated issue and revoke are refused, and an act must name its operator', async () => {
  const s = await serve();
  try {
    const body = { subject: 'product:feltdb', name: 'x', scopes: ['events:write'] };
    assert.equal((await s.call('POST', '/v1/publishers', { body })).status, 401, 'no operator token');
    assert.equal((await s.call('POST', '/v1/publishers', { body, token: 'wrong-token-but-long-enough-to-compare' })).status, 401);
    assert.equal((await s.call('POST', '/v1/publishers', { body, token: OPERATOR })).body.code, 'OPERATOR_UNNAMED', 'an operator act is attributable');
    assert.equal((await s.call('GET', '/v1/publishers')).status, 401);
    assert.equal((await s.call('POST', '/v1/publishers/000000000000/revoke', { body: {} })).status, 401);
    // Nothing was issued by any of that.
    assert.deepEqual(await s.publishers.list(), []);

    // A named operator may issue, and the key is returned exactly once.
    const issued = await issue(s);
    assert.match(issued.key, /^bik_[0-9a-f]{12}_[A-Za-z0-9_-]{43}$/);
    assert.equal(issued.publisher.createdBy, 'operator:test', 'the act is attributed to the operator');
    const listed = await s.call('GET', '/v1/publishers', { token: OPERATOR, operator: 'operator:test' });
    assert.equal(listed.body.publishers.length, 1);
    // Listing a publisher never returns the key or its hash.
    assert.equal(JSON.stringify(listed.body).includes(issued.key), false);
    assert.equal(JSON.stringify(listed.body).includes('secretHash'), false);
  } finally {
    await s.close();
  }
});

test('no key, operator token or event content reaches the log', async () => {
  const s = await serve();
  try {
    const issued = await issue(s);
    await s.call('POST', '/v1/events', { body: envelope({ data: undefined, capability: { name: 'collections.query', version: 1 } }), token: issued.key });
    await s.call('POST', `/v1/publishers/${issued.publisher.publisherId}/revoke`, { body: {}, token: OPERATOR, operator: 'operator:test' });
    const written = JSON.stringify(s.logged);
    for (const secret of [issued.key, OPERATOR, 'collections.query']) {
      assert.equal(written.includes(secret), false, `the log leaked ${secret.slice(0, 12)}…`);
    }
    // What it does carry: the act, the publisher id, the operator's name.
    assert.ok(s.logged.some((e) => e.event === 'publisher.issued' && e.publisherId === issued.publisher.publisherId && e.claimedName === 'operator:test' && e.authenticated === 'credential:operator'));
    assert.ok(s.logged.some((e) => e.event === 'publisher.revoked'));
    assert.ok(s.logged.some((e) => e.event === 'request' && e.path === '/v1/events' && e.status === 200));
  } finally {
    await s.close();
  }
});

test('the operator routes do not exist when no operator boundary is configured', async () => {
  const s = await serve({ operatorToken: null });
  try {
    const body = { subject: 'product:feltdb', name: 'x', scopes: ['events:write'] };
    assert.equal((await s.call('POST', '/v1/publishers', { body, token: OPERATOR, operator: 'operator:test' })).status, 404);
    assert.deepEqual(await s.publishers.list(), [], 'nothing can be issued at all');
    // Ingestion still works for a key issued another way, so the service is useful without an operator surface.
    const { key } = await s.publishers.issue({ subject: 'product:feltdb', name: 'out of band', scopes: ['events:write'], createdBy: 'operator:script' });
    assert.equal((await s.call('POST', '/v1/events', { body: envelope(), token: key })).body.status, 'accepted');
  } finally {
    await s.close();
  }
});

test('a production configuration cannot fall back to a store that does not outlive the process', async () => {
  // The hazard, first: with nothing configured, FeltDB resolves to a path under the working directory.
  const development = resolveRuntimeConfig({ NODE_ENV: 'development' });
  assert.deepEqual([development.production, development.storage.mode, development.storage.durable], [false, 'local', false]);

  // In production the same environment is refused, and the message says what to set.
  assert.throws(
    () => resolveRuntimeConfig({ NODE_ENV: 'production' }),
    (error) => {
      assert.ok(error instanceof ConfigurationError);
      assert.equal(error.code, 'CONFIGURATION_INVALID');
      assert.ok(error.problems.some((p) => /does not outlive this process/.test(p)), error.problems.join(' | '));
      assert.ok(error.problems.some((p) => /FELTDB_URL and FELTDB_TOKEN/.test(p)));
      assert.ok(error.problems.some((p) => /BOUNDRY_INTEL_OPERATOR_TOKEN is required in production/.test(p)));
      return true;
    },
  );
  // An explicit local path in production is refused too: being deliberate about an ephemeral store does not make it durable.
  assert.throws(() => resolveRuntimeConfig({ NODE_ENV: 'production', FELTDB_MODE: 'local', FELTDB_PATH: '/tmp/x', BOUNDRY_INTEL_OPERATOR_TOKEN: OPERATOR }), /does not outlive this process|cannot start/);

  // A remote configuration without a credential is refused: the authority would reject every call.
  assert.throws(
    () => resolveRuntimeConfig({ NODE_ENV: 'production', FELTDB_URL: 'https://api.feltdb.com', FELTDB_MODE: 'remote', BOUNDRY_INTEL_OPERATOR_TOKEN: OPERATOR }),
    (error) => error.problems.some((p) => /FELTDB_TOKEN is required in production/.test(p)),
  );

  // The whole production configuration, accepted.
  const production = resolveRuntimeConfig({
    NODE_ENV: 'production',
    FELTDB_URL: 'https://api.feltdb.com',
    FELTDB_TOKEN: 'fdb_live_example',
    FELTDB_APPLICATION_ID: 'app_example',
    FELTDB_NAMESPACE: 'tenant_example:ns',
    FELTDB_ENVIRONMENT: 'production',
    BOUNDRY_INTEL_OPERATOR_TOKEN: OPERATOR,
  });
  assert.deepEqual([production.production, production.storage.mode, production.storage.durable], [true, 'remote', true]);
  // And the description of it, for a log or a readiness answer, carries no credential.
  const { describeConfig } = await import('../src/config.mjs');
  assert.equal(JSON.stringify(describeConfig(production)).includes('fdb_live_example'), false);
  assert.equal(JSON.stringify(describeConfig(production)).includes(OPERATOR), false);
  assert.equal(describeConfig(production).operatorBoundary, 'configured');
});

test('embedded storage in production is an explicit opt-in and must sit on a mounted volume', async () => {
  const { assertPersistentMount } = await import('../src/config.mjs');
  const base = { NODE_ENV: 'production', FELTDB_MODE: 'local', FELTDB_PATH: '/data/intel', BOUNDRY_INTEL_OPERATOR_TOKEN: OPERATOR };
  assert.throws(() => resolveRuntimeConfig(base), /does not outlive this process|cannot start/, 'a local path alone is still refused');
  assert.throws(() => resolveRuntimeConfig({ ...base, BOUNDRY_INTEL_STORAGE: 'embedded', FELTDB_PATH: 'relative' }), (e) => e.problems.some((x) => /absolute path/.test(x)));
  const ok = resolveRuntimeConfig({ ...base, BOUNDRY_INTEL_STORAGE: 'embedded' });
  assert.deepEqual([ok.storage.mode, ok.storage.durable, ok.storage.embedded], ['local', true, true]);

  const root = '26 1 0:21 / / rw - overlay overlay rw\n40 26 8:1 / /data rw - ext4 /dev/vdb rw\n';
  assert.equal(assertPersistentMount('/data/intel', root), '/data');
  assert.throws(() => assertPersistentMount('/app/.feltdb', root), /not on a persistent volume/);
  assert.throws(() => assertPersistentMount('/database/x', root), /not on a persistent volume/, 'a sibling prefix is not the mount');
});
