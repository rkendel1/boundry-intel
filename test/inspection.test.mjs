/**
 * The read surface: AppPort capabilities over the real stores, reached over a real socket through the same handler
 * the service runs, plus the MCP projection and the CLI's export. Every test runs on a real local FeltDB with the
 * application contract enforced.
 *
 * What these tests hold the surface to: it tells the truth about what is stored (counts, time ranges, provenance and
 * digests match the store), it pages without losing or repeating records, it refuses anything it does not name, it
 * cannot be reached without a read credential and an attributable name, a reader cannot do operator work, and reading
 * never changes what is stored.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

import { createRequest } from '@appport/protocol';

import { createIntelHandler } from '../src/server.mjs';
import { resolveRuntimeConfig } from '../src/config.mjs';
import { storageReadiness } from '../src/main.mjs';
import { IngestionMonitor, IntelInspector } from '../src/inspection.mjs';
import { createIntelApplication } from '../src/capabilities.mjs';
import { client, exportAll, run } from '../scripts/intel.mjs';
import { harness, envelope, docs } from './support.mjs';

const OPERATOR = 'operator-token-at-least-thirty-two-chars';
const READER = 'reader-token-that-is-also-32-chars-long';
const AS = 'test-reader';

/** A clock the test moves. Stores, monitor and inspector all read it, so freshness is deterministic. */
const clock = (start = '2026-11-10T00:00:00Z') => {
  let t = Date.parse(start);
  return { now: () => new Date(t), advance: (seconds) => (t += seconds * 1000), tick: () => new Date((t += 1000)) };
};

async function serve({ readiness, operatorToken = OPERATOR, readerToken = READER } = {}) {
  const c = clock();
  const h = await harness({ now: c.tick });
  const config = resolveRuntimeConfig({ NODE_ENV: 'test', PORT: '0', BOUNDRY_INTEL_OPERATOR_TOKEN: operatorToken, ...(readerToken ? { BOUNDRY_INTEL_READER_TOKEN: readerToken } : {}) });
  const logged = [];
  const log = (entry) => logged.push(entry);
  const ready = readiness ?? storageReadiness(h.events);
  const monitor = new IngestionMonitor({ now: c.now });
  const inspector = new IntelInspector({ db: h.db, events: h.events, publishers: h.publishers, registry: h.store, monitor, readiness: ready, now: c.now, service: { name: 'boundry-intel', version: 'test', startedAt: c.now().toISOString(), storage: { mode: 'local' } } });
  const application = createIntelApplication(inspector, { version: 'test', onRead: (r) => log({ event: 'intel.read', ...r }) });
  const server = createServer(createIntelHandler({ config: { ...config, port: 0 }, publishers: h.publishers, events: h.events, readiness: ready, application, monitor, log }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const http = async (method, path, { body, token, as, headers = {} } = {}) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}), ...(as ? { 'boundry-operator': as } : {}), ...headers },
      ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    });
    const text = await response.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    return { status: response.status, body: parsed, headers: response.headers };
  };
  /** One AppPort capability call; returns the response envelope. */
  const call = async (name, input = {}, { token = READER, as = AS } = {}) => {
    const r = await http('POST', '/appport', { body: createRequest({ requestId: `req_${Math.random().toString(36).slice(2)}`, capability: { name, version: 1 }, input }), token, as });
    return { status: r.status, ...r.body };
  };
  const out = async (name, input) => {
    const r = await call(name, input);
    assert.equal(r.ok, true, JSON.stringify(r));
    return r.output;
  };
  const publisher = async (product = 'feltdb') => (await h.publishers.issue({ subject: `product:${product}`, name: `${product} publisher`, scopes: ['events:write'], createdBy: 'operator:test' })).key;
  const post = (key, body) => http('POST', '/v1/events', { body, token: key });

  return {
    ...h,
    clock: c,
    base,
    http,
    call,
    out,
    publisher,
    post,
    logged,
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      await h.close();
    },
  };
}

const ev = (n, o = {}) => envelope({ id: `evt_${String(n).padStart(8, '0')}`, ...o });

/* ------------------------------------------------ discovery ------------------------------------------------ */

test('an empty service says it is empty, not broken', async () => {
  const s = await serve();
  try {
    const status = await s.out('intel.status');
    assert.equal(status.storage.ready, true);
    assert.equal(status.freshness.state, 'empty');
    assert.equal(status.freshness.latestEventReceivedAt, null);
    assert.deepEqual(status.collections.map((c) => [c.name, c.count, c.earliest, c.latest]), [
      ['intel_events', 0, null, null],
      ['intel_publishers', 0, null, null],
      ['registry_records', 0, null, null],
      ['registry_revisions', 0, null, null],
    ]);
    assert.deepEqual((await s.out('intel.events.list')).events, []);
    assert.equal((await s.out('intel.events.list')).nextCursor, null);
    const diagnosis = await s.out('intel.diagnostics');
    assert.deepEqual(diagnosis.findings.map((f) => f.code).sort(), ['NO_EVENTS', 'NO_PUBLISHERS', 'REGISTRY_EMPTY']);
    assert.equal(diagnosis.findings.find((f) => f.code === 'NO_PUBLISHERS').severity, 'critical');
  } finally {
    await s.close();
  }
});

test('datasets are described from the one application contract, with true counts and time ranges', async () => {
  const s = await serve();
  try {
    const key = await s.publisher();
    for (const n of [1, 2, 3]) assert.equal((await s.post(key, ev(n))).status, 200);
    await s.store.assert(docs.product());
    const { datasets, application } = await s.out('intel.datasets.list');
    assert.equal(application.name, 'boundry-intel');
    const byName = Object.fromEntries(datasets.map((d) => [d.name, d]));
    assert.deepEqual(Object.keys(byName).sort(), ['intel_events', 'intel_publishers', 'registry_records', 'registry_revisions']);

    const events = byName.intel_events;
    assert.equal(events.classification, 'raw-observation');
    assert.equal(events.count, 3);
    assert.ok(events.earliest < events.latest, 'the time range spans the stored records');
    assert.deepEqual(events.fields.find((f) => f.name === 'event'), { name: 'event', type: 'json', required: true });
    assert.deepEqual(events.indexedFields.sort(), ['correlationId', 'productId', 'reference', 'type']);
    assert.match(events.retention, /indefinitely/);
    assert.equal(byName.intel_publishers.count, 1);
    assert.equal(byName.registry_records.count, 1);
    assert.deepEqual(byName.registry_records.fields.find((f) => f.name === 'fromKey'), { name: 'fromKey', type: 'reference', required: false, references: 'registry_records' });
    assert.ok(!byName.intel_publishers.fields.some((f) => f.name === 'secretHash' && f.exposed), 'the hash is described, never exposed');
  } finally {
    await s.close();
  }
});

/* ------------------------------------------------ retrieval and provenance ------------------------------------------------ */

test('an event is retrieved with its publisher, its timestamps and a digest that still matches', async () => {
  const s = await serve();
  try {
    const key = await s.publisher();
    const sent = ev(7, { context: { correlationId: 'session_abc' } });
    const accepted = (await s.post(key, sent)).body;
    const got = await s.out('intel.events.get', { productId: 'feltdb', eventId: sent.id });
    assert.deepEqual(got.event, sent, 'the envelope comes back exactly as it was accepted');
    assert.equal(got.digest, accepted.digest);
    assert.equal(got.provenance.integrity.matches, true);
    assert.equal(got.provenance.integrity.recomputedDigest, accepted.digest);
    assert.equal(got.provenance.publisher.subject, 'product:feltdb');
    assert.equal(got.provenance.publisher.createdBy, 'operator:test');
    assert.ok(!('secretHash' in got.provenance.publisher) && !JSON.stringify(got).includes(key), 'no key and no hash');

    const missing = await s.call('intel.events.get', { productId: 'feltdb', eventId: 'evt_nope' });
    assert.deepEqual([missing.status, missing.ok, missing.error.code], [404, false, 'NOT_FOUND']);
  } finally {
    await s.close();
  }
});

test('registry records come back with provenance, history and relationships', async () => {
  const s = await serve();
  try {
    for (const d of [docs.product(), docs.repository(), docs.relationship('repository-of', 'repository:github.com/rkendel1/flow_db', 'product:feltdb')]) assert.equal((await s.store.assert(d)).status, 'recorded');
    const current = await s.store.get('product:feltdb');
    assert.equal((await s.store.revise(docs.product({ status: 'available' }), { expectedDigest: current.digest })).status, 'revised');

    const list = await s.out('intel.registry.list', { kind: 'product' });
    assert.equal(list.records.length, 1);
    assert.equal(list.records[0].provenance.sourceSystem, 'operator');
    assert.equal(list.records[0].revision, 2);

    const record = await s.out('intel.registry.get', { id: 'product:feltdb' });
    assert.deepEqual(record.history.map((h) => [h.revision, h.document.status]), [[1, 'preview'], [2, 'available']]);
    assert.equal(record.relationships.incoming.length, 1);
    assert.equal(record.relationships.incoming[0].document.from, 'repository:github.com/rkendel1/flow_db');
    assert.equal((await s.call('intel.registry.get', { id: 'product:nothing' })).error.code, 'NOT_FOUND');
  } finally {
    await s.close();
  }
});

/* ------------------------------------------------ filtering and pagination ------------------------------------------------ */

test('filters are named fields only, and each one narrows correctly', async () => {
  const s = await serve();
  try {
    const feltdb = await s.publisher('feltdb');
    const appport = await s.publisher('appport');
    // One request per event: a batch is accepted at one instant, so its events share a receivedAt (ties are ordered
    // by storage id, stable but not by position in the batch).
    for (const e of [ev(1), ev(2, { context: { correlationId: 'session_c1' } }), ev(3)]) assert.equal((await s.post(feltdb, e)).status, 200);
    const cutoff = s.clock.now().toISOString();
    await s.post(appport, ev(4, { product: { id: 'appport', version: '1.5.0' } }));

    const ids = async (input) => (await s.out('intel.events.list', input)).events.map((e) => e.eventId);
    assert.deepEqual(await ids({}), ['evt_00000004', 'evt_00000003', 'evt_00000002', 'evt_00000001'], 'newest first');
    assert.deepEqual(await ids({ order: 'oldest' }), ['evt_00000001', 'evt_00000002', 'evt_00000003', 'evt_00000004']);
    assert.deepEqual(await ids({ productId: 'appport' }), ['evt_00000004']);
    assert.deepEqual(await ids({ correlationId: 'session_c1' }), ['evt_00000002']);
    assert.deepEqual(await ids({ receivedAfter: cutoff }), ['evt_00000004']);
    assert.deepEqual(await ids({ receivedBefore: cutoff, productId: 'feltdb' }), ['evt_00000003', 'evt_00000002', 'evt_00000001']);
    const publisherId = (await s.publishers.list({ productId: 'appport' }))[0].publisherId;
    assert.deepEqual(await ids({ publisherId }), ['evt_00000004']);
  } finally {
    await s.close();
  }
});

test('a large set pages to the end with nothing lost or repeated, and export returns every record', async () => {
  const s = await serve();
  try {
    const key = await s.publisher();
    const total = 450;
    for (let start = 1; start <= total; start += 100) {
      const batch = Array.from({ length: Math.min(100, total - start + 1) }, (_, i) => ev(start + i));
      const r = await s.post(key, batch);
      assert.ok(r.body.answers.every((a) => a.status === 'accepted'));
    }
    const seen = [];
    let cursor;
    let pages = 0;
    do {
      const page = await s.out('intel.events.list', { limit: 200, ...(cursor ? { cursor } : {}) });
      assert.ok(page.events.length <= 200, 'a page never exceeds its limit');
      seen.push(...page.events.map((e) => e.eventId));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor);
    assert.equal(pages, 3);
    assert.equal(seen.length, total);
    assert.equal(new Set(seen).size, total, 'no record appears twice');

    const status = await s.out('intel.status');
    assert.equal(status.collections.find((c) => c.name === 'intel_events').count, total);

    // Export, through the CLI's own client against the live socket.
    const api = client({ url: s.base, token: READER, as: AS });
    const exported = await exportAll(api, { what: 'events', input: {} });
    assert.equal(exported.count, total);
    assert.equal(exported.complete, true);
    assert.equal(exported.pages, 3);
    const stored = await s.events.get('feltdb', 'evt_00000123');
    const fromExport = exported.events.find((e) => e.eventId === 'evt_00000123');
    for (const field of ['reference', 'eventId', 'productId', 'occurredAt', 'receivedAt', 'publisherId', 'digest']) assert.equal(fromExport[field], stored[field], field);
    assert.deepEqual(fromExport.event, stored.event);

    const capped = await exportAll(api, { what: 'events', input: {}, max: 250 });
    assert.equal(capped.count, 200, 'an export stops at the last whole page within --max');
    assert.equal(capped.complete, false);
    assert.ok(capped.resumeCursor, 'a capped export says where to resume');
  } finally {
    await s.close();
  }
});

/* ------------------------------------------------ invalid input ------------------------------------------------ */

test('anything the contract does not name is refused as invalid input', async () => {
  const s = await serve();
  try {
    const invalid = async (name, input) => {
      const r = await s.call(name, input);
      assert.equal(r.ok, false, `${name} ${JSON.stringify(input)} should be refused`);
      assert.equal(r.error.code, 'INVALID_INPUT', JSON.stringify(r.error));
      assert.equal(r.status, 400);
    };
    await invalid('intel.events.list', { where: { productId: 'x' } });
    await invalid('intel.events.list', { collection: 'intel_publishers' });
    await invalid('intel.events.list', { limit: 201 });
    await invalid('intel.events.list', { limit: 0 });
    await invalid('intel.events.list', { order: 'random' });
    await invalid('intel.events.list', { receivedAfter: 'yesterday' });
    await invalid('intel.events.list', { cursor: 'not-a-cursor' });
    await invalid('intel.events.get', { productId: 'feltdb' });
    await invalid('intel.registry.list', { kind: 'secret' });
    const unknown = await s.call('intel.events.delete', {});
    assert.equal(unknown.error.code, 'UNKNOWN_CAPABILITY');
  } finally {
    await s.close();
  }
});

test('a cursor from one query cannot be replayed against another', async () => {
  const s = await serve();
  try {
    const key = await s.publisher();
    await s.post(key, [ev(1), ev(2), ev(3)]);
    const first = await s.out('intel.events.list', { limit: 1 });
    assert.ok(first.nextCursor);
    const replay = await s.call('intel.events.list', { limit: 1, productId: 'other', cursor: first.nextCursor });
    assert.equal(replay.ok, false);
    assert.equal(replay.error.code, 'INVALID_INPUT');
  } finally {
    await s.close();
  }
});

/* ------------------------------------------------ authorization and read-only ------------------------------------------------ */

test('the read surface cannot be reached without a read credential and a name', async () => {
  const s = await serve();
  try {
    const key = await s.publisher();
    for (const [method, path] of [['GET', '/.well-known/appport'], ['GET', '/appport/manifest'], ['POST', '/appport'], ['POST', '/mcp']]) {
      const body = method === 'POST' ? {} : undefined;
      assert.equal((await s.http(method, path, { body })).status, 401, `${path} without a token`);
      assert.equal((await s.http(method, path, { body, token: 'x'.repeat(40), as: AS })).status, 401, `${path} with a wrong token`);
      assert.equal((await s.http(method, path, { body, token: key, as: AS })).status, 401, `${path} with a publisher key`);
      assert.equal((await s.http(method, path, { body, token: READER })).status, 400, `${path} without Boundry-Operator`);
    }
    assert.equal((await s.http('GET', '/appport/manifest', { token: READER, as: AS })).status, 200);
    assert.equal((await s.http('GET', '/appport/manifest', { token: OPERATOR, as: AS })).status, 200, 'the operator reads too');
  } finally {
    await s.close();
  }
});

test('the reader token reads and does nothing else', async () => {
  const s = await serve();
  try {
    const issue = await s.http('POST', '/v1/publishers', { body: { subject: 'product:feltdb', name: 'x', scopes: ['events:write'] }, token: READER, as: AS });
    assert.equal(issue.status, 401, 'a reader cannot issue a publisher key');
    assert.equal((await s.http('GET', '/v1/publishers', { token: READER, as: AS })).status, 401);
    assert.equal((await s.http('POST', '/v1/events', { body: ev(1), token: READER })).status, 403, 'a reader is not a publisher');
  } finally {
    await s.close();
  }
});

test('every capability is a declared observation, and calling all of them changes nothing stored', async () => {
  const s = await serve();
  try {
    const key = await s.publisher();
    await s.post(key, [ev(1), ev(2)]);
    await s.store.assert(docs.product());
    const manifest = (await s.http('GET', '/appport/manifest', { token: READER, as: AS })).body;
    const intel = manifest.capabilities.filter((c) => c.name.startsWith('intel.'));
    assert.deepEqual(intel.map((c) => c.name).sort(), ['intel.datasets.list', 'intel.diagnostics', 'intel.events.get', 'intel.events.list', 'intel.publishers.list', 'intel.registry.get', 'intel.registry.list', 'intel.status']);
    for (const c of intel) {
      assert.equal(c.effect, 'observation', c.name);
      assert.deepEqual(c.authorization, ['intel.read'], c.name);
    }

    const snapshot = async () => {
      const all = {};
      for (const collection of ['intel_events', 'intel_publishers', 'registry_records', 'registry_revisions']) all[collection] = (await s.db.query({ collection, limit: 1000 })).records;
      return JSON.stringify(all);
    };
    const before = await snapshot();
    for (const [name, input] of [['intel.status', {}], ['intel.datasets.list', {}], ['intel.events.list', {}], ['intel.events.get', { productId: 'feltdb', eventId: 'evt_00000001' }], ['intel.registry.list', {}], ['intel.registry.get', { id: 'product:feltdb' }], ['intel.publishers.list', {}], ['intel.diagnostics', {}]]) {
      assert.equal((await s.call(name, input)).ok, true, name);
    }
    assert.equal(await snapshot(), before, 'reading wrote nothing, not even lastUsedAt');
  } finally {
    await s.close();
  }
});

test('every read is attributed in the log, and no credential reaches the log', async () => {
  const s = await serve();
  try {
    await s.out('intel.status');
    const read = s.logged.find((e) => e.event === 'intel.read');
    assert.deepEqual([read.capability, read.principal], ['intel.status', AS]);
    const text = JSON.stringify(s.logged);
    assert.ok(!text.includes(READER) && !text.includes(OPERATOR));
  } finally {
    await s.close();
  }
});

/* ------------------------------------------------ failures and staleness ------------------------------------------------ */

test('refused submissions are visible, labelled as not durable, though nothing was stored for them', async () => {
  const s = await serve();
  try {
    const key = await s.publisher();
    assert.equal((await s.post(key, ev(1))).status, 200);
    assert.equal((await s.post(key, { ...ev(2), type: 'not.a.type' })).status, 400);
    assert.equal((await s.post(key, ev(3, { product: { id: 'appport', version: '1' } }))).status, 403);
    assert.equal((await s.post('bik_000000000000_' + 'a'.repeat(43), ev(4))).status, 403);
    assert.equal((await s.http('POST', '/v1/events', { body: ev(5) })).status, 401);
    assert.equal((await s.post(key, '{not json')).status, 400);

    const status = await s.out('intel.status');
    const seen = status.ingestion.sinceProcessStart;
    assert.equal(seen.durable, false);
    assert.deepEqual(
      { accepted: seen.tally.accepted, rejected: seen.tally.rejected, unauthorized: seen.tally.unauthorized, unauthenticated: seen.tally.unauthenticated, invalidRequest: seen.tally.invalidRequest },
      { accepted: 1, rejected: 1, unauthorized: 2, unauthenticated: 1, invalidRequest: 1 },
    );
    assert.equal(seen.recentRefusals[0].status, 'invalidRequest', 'newest refusal first');
    assert.ok(seen.recentRefusals.some((r) => r.status === 'unauthorized' && r.issues.includes('event.product.forbidden')));
    assert.equal(status.collections.find((c) => c.name === 'intel_events').count, 1, 'refusals stored nothing');

    const diagnosis = await s.out('intel.diagnostics');
    assert.ok(diagnosis.findings.some((f) => f.code === 'REFUSALS_SINCE_START'));
  } finally {
    await s.close();
  }
});

test('a storage failure on ingestion is counted and diagnosed', async () => {
  const s = await serve();
  try {
    const key = await s.publisher();
    const original = s.db.transaction.bind(s.db);
    s.db.transaction = async () => {
      throw Object.assign(new Error('disk gone'), { code: 'EIO' });
    };
    assert.equal((await s.post(key, ev(1))).status, 503);
    s.db.transaction = original;
    const diagnosis = await s.out('intel.diagnostics');
    const failure = diagnosis.findings.find((f) => f.code === 'STORAGE_FAILURES_SINCE_START');
    assert.equal(failure.severity, 'critical');
    assert.equal(failure.evidence.lastStorageFailure.code, 'EIO');
  } finally {
    await s.close();
  }
});

test('unready storage is reported as such, not as an empty store', async () => {
  const s = await serve({ readiness: async () => ({ ready: false, detail: 'FORBIDDEN: no scope' }) });
  try {
    const status = await s.out('intel.status');
    assert.equal(status.storage.ready, false);
    assert.equal(status.freshness.state, 'unknown');
    const diagnosis = await s.out('intel.diagnostics');
    assert.deepEqual(diagnosis.findings.map((f) => f.code), ['STORAGE_UNREADY']);
    assert.equal(diagnosis.findings[0].evidence.detail, 'FORBIDDEN: no scope');
  } finally {
    await s.close();
  }
});

test('stale data and silent publishers are detected against the threshold the caller names', async () => {
  const s = await serve();
  try {
    const busy = await s.publisher('feltdb');
    await s.publisher('appport'); // issued, never used
    await s.post(busy, ev(1));
    assert.equal((await s.out('intel.status')).freshness.state, 'fresh');

    s.clock.advance(2 * 24 * 60 * 60);
    const status = await s.out('intel.status');
    assert.equal(status.freshness.state, 'stale');
    assert.ok(status.freshness.ageSeconds >= 2 * 24 * 60 * 60 - 5);
    assert.equal((await s.out('intel.status', { staleAfterSeconds: 3 * 24 * 60 * 60 })).freshness.state, 'fresh', 'the threshold is the caller’s');

    const { publishers } = await s.out('intel.publishers.list');
    assert.deepEqual(publishers.map((p) => [p.productId, p.state]).sort(), [['appport', 'never-used'], ['feltdb', 'idle']]);
    const codes = (await s.out('intel.diagnostics')).findings.map((f) => f.code);
    for (const code of ['DATA_STALE', 'PUBLISHER_IDLE', 'PUBLISHER_NEVER_USED']) assert.ok(codes.includes(code), code);
  } finally {
    await s.close();
  }
});

/* ------------------------------------------------ agents: MCP over the same application ------------------------------------------------ */

test('agents reach the same capabilities as MCP tools, under the same credential', async () => {
  const s = await serve();
  try {
    const key = await s.publisher();
    await s.post(key, ev(1));
    const rpc = (body, { token = READER, as = AS } = {}) => s.http('POST', '/mcp', { body, token, as, headers: { accept: 'application/json, text/event-stream' } });

    const listed = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    const tools = listed.body.result.tools.map((t) => t.name).sort();
    assert.deepEqual(tools, ['intel_datasets_list', 'intel_diagnostics', 'intel_events_get', 'intel_events_list', 'intel_publishers_list', 'intel_registry_get', 'intel_registry_list', 'intel_status']);
    const listTool = listed.body.result.tools.find((t) => t.name === 'intel_events_list');
    assert.equal(listTool.inputSchema.properties.limit.maximum, 200, 'the agent sees the same limits');

    const called = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'intel_events_list', arguments: { limit: 5 } } });
    assert.equal(called.body.result.isError, undefined, JSON.stringify(called.body));
    assert.equal(called.body.result.structuredContent.events[0].eventId, 'evt_00000001');

    const refused = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'intel_events_list', arguments: { limit: 5000 } } });
    assert.equal(refused.body.result.isError, true);

    assert.equal((await rpc({ jsonrpc: '2.0', id: 4, method: 'tools/list', params: {} }, { token: 'wrong'.repeat(10) })).status, 401);
  } finally {
    await s.close();
  }
});

/* ------------------------------------------------ the CLI ------------------------------------------------ */

test('the CLI runs each command against the service and refuses to run without a name', async () => {
  const s = await serve();
  try {
    const key = await s.publisher();
    await s.post(key, ev(1));
    const env = { BOUNDRY_INTEL_URL: s.base, BOUNDRY_INTEL_TOKEN: READER, BOUNDRY_INTEL_AS: AS };
    const cli = async (argv, e = env) => {
      let stdout = '';
      let stderr = '';
      const code = await run(argv, e, { out: (t) => (stdout += t), err: (t) => (stderr += t) });
      return { code, stdout, stderr, json: () => JSON.parse(stdout) };
    };
    assert.equal((await cli(['status'])).json().collections[0].count, 1);
    assert.equal((await cli(['events', '--product', 'feltdb', '--limit', '1'])).json().events[0].eventId, 'evt_00000001');
    assert.equal((await cli(['event', 'feltdb', 'evt_00000001'])).json().provenance.integrity.matches, true);
    assert.equal((await cli(['datasets'])).json().datasets.length, 4);
    assert.equal((await cli(['publishers'])).json().publishers.length, 1);
    assert.ok(Array.isArray((await cli(['diagnose'])).json().findings));
    assert.equal((await cli(['export', 'events'])).json().count, 1);
    assert.ok((await cli(['capabilities'])).json().capabilities.length >= 8);
    const missing = await cli(['event', 'feltdb', 'evt_nope']);
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /NOT_FOUND/);
    assert.equal((await cli(['status'], { BOUNDRY_INTEL_URL: s.base, BOUNDRY_INTEL_TOKEN: READER })).code, 2);
    assert.equal((await cli(['events', '--bogus', 'x'])).code, 2);
  } finally {
    await s.close();
  }
});
