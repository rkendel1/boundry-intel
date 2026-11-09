import assert from 'node:assert/strict';
import test from 'node:test';

import { capabilityProjection, eventReference, integrationProjection, journey, productProjection, repositoryProjection, snapshot } from '../src/index.mjs';
import { docs, harness, observation, provenance } from './support.mjs';

const FLOW_DB = 'repository:github.com/rkendel1/flow_db';
const FELTKIT = 'repository:github.com/rkendel1/feltkit';

/** A small slice of the ecosystem: two products, their repositories, versions, one shared capability, one dashboard. */
async function seed(store) {
  const results = await store.assertAll([
    docs.product(),
    docs.product({ productId: 'feltkit', name: 'FeltKit', status: 'preview', homepage: 'https://getfeltkit.com' }),
    docs.repository(),
    docs.repository({ name: 'feltkit', provenance: provenance({ source: { system: 'github', locator: 'https://github.com/rkendel1/feltkit' } }) }),
    docs.version(),
    docs.version({ version: '0.20.0', releasedAt: '2026-10-01T00:00:00Z', packages: [{ registry: 'npm', name: '@feltdb/core', version: '0.20.0' }] }),
    docs.version({ productId: 'feltkit', version: '0.3.18', releasedAt: '2026-11-05T00:00:00Z', packages: [{ registry: 'npm', name: '@feltdb/feltkit', version: '0.3.18' }] }),
    docs.capability(),
    docs.capability({ name: 'applications.compose', version: undefined, summary: 'Compose an application from FeltDB and AppPort' }),
    docs.integration(),
    docs.relationship('repository-of', FLOW_DB, 'product:feltdb', { role: 'primary' }),
    docs.relationship('repository-of', FELTKIT, 'product:feltkit', { role: 'primary' }),
    docs.relationship('released-from', 'product-version:feltdb@0.21.0', FLOW_DB, { tag: 'v0.21.0', commit: 'c72c1be' }),
    docs.relationship('released-from', 'product-version:feltdb@0.20.0', FLOW_DB, { tag: 'v0.20.0' }),
    docs.relationship('released-from', 'product-version:feltkit@0.3.18', FELTKIT, { tag: 'v0.3.18' }),
    docs.relationship('provides', 'product:feltdb', 'capability:collections.query@1', { mechanism: 'sdk' }),
    docs.relationship('provides', 'product-version:feltkit@0.3.18', 'capability:collections.query@1', { mechanism: 'mcp' }),
    docs.relationship('provides', 'product:feltkit', 'capability:applications.compose', { mechanism: 'cli' }),
    docs.relationship('authorized-for', 'integration:ecosystem-dashboard', 'product:feltdb', { mode: 'read' }),
    docs.relationship('authorized-for', 'integration:ecosystem-dashboard', 'product:feltkit', { mode: 'read' }),
    docs.relationship('evidenced-by', 'product-version:feltdb@0.21.0', eventReference('feltdb', 'rel_0.21.0_000001'), { eventType: 'product.released', occurredAt: '2026-11-01T00:00:00Z' }, { provenance: observation({ source: { system: 'boundry.event' } }) }),
    docs.relationship('evidenced-by', 'product:feltdb', eventReference('feltdb', 'evt_disc_0000001'), { eventType: 'product.discovered' }, { provenance: observation({ source: { system: 'boundry.event' } }) }),
  ]);
  assert.deepEqual(results.map((r) => r.status), results.map(() => 'recorded'), JSON.stringify(results.filter((r) => r.status !== 'recorded')));
}

test('by product: versions, repositories, capabilities, integrations and evidence, deterministically ordered', async () => {
  const h = await harness();
  try {
    await seed(h.store);
    const p = await productProjection(h.store, 'feltdb');
    assert.equal(p.product.document.name, 'FeltDB');
    assert.deepEqual(p.versions.map((v) => v.version.document.version), ['0.20.0', '0.21.0'], 'by releasedAt');
    assert.deepEqual(p.versions[1].releasedFrom.map((e) => [e.record.id, e.attributes.tag, e.attributes.commit]), [[FLOW_DB, 'v0.21.0', 'c72c1be']]);
    assert.deepEqual(p.versions[1].evidence.map((e) => [e.reference, e.attributes.eventType]), [['event:feltdb:rel_0.21.0_000001', 'product.released']]);
    assert.deepEqual(p.versions[0].evidence, []);
    assert.deepEqual(p.repositories.map((e) => [e.record.id, e.attributes.role]), [[FLOW_DB, 'primary']]);
    assert.deepEqual(p.capabilities.map((e) => [e.record.id, e.attributes.mechanism]), [['capability:collections.query@1', 'sdk']]);
    assert.deepEqual(p.integrations.map((e) => [e.record.id, e.attributes.mode]), [['integration:ecosystem-dashboard', 'read']]);
    assert.deepEqual(p.evidence.map((e) => e.reference), ['event:feltdb:evt_disc_0000001']);
    assert.equal(p.evidence[0].provenance.source.system, 'boundry.event');
    assert.equal(await productProjection(h.store, 'nothing'), null);
    // Capabilities provided by a version count for the product too.
    const k = await productProjection(h.store, 'feltkit');
    assert.deepEqual(k.capabilities.map((e) => [e.record.id, e.attributes.mechanism]).sort(), [['capability:applications.compose', 'cli'], ['capability:collections.query@1', 'mcp']]);
    assert.deepEqual(JSON.stringify(await productProjection(h.store, 'feltdb')), JSON.stringify(p), 'the same state gives the same projection');
  } finally {
    await h.close();
  }
});

test('by repository and by capability', async () => {
  const h = await harness();
  try {
    await seed(h.store);
    const r = await repositoryProjection(h.store, FLOW_DB);
    assert.deepEqual(r.products.map((e) => e.record.id), ['product:feltdb']);
    assert.deepEqual(r.releases.map((e) => [e.record.document.version, e.attributes.tag]).sort(), [['0.20.0', 'v0.20.0'], ['0.21.0', 'v0.21.0']]);
    assert.deepEqual(r.integrations, []);
    assert.equal(await repositoryProjection(h.store, 'repository:github.com/rkendel1/nothing'), null);

    const c = await capabilityProjection(h.store, 'capability:collections.query@1');
    assert.deepEqual(c.providers.map((e) => [e.record.id, e.attributes.mechanism]).sort(), [['product-version:feltkit@0.3.18', 'mcp'], ['product:feltdb', 'sdk']]);
    assert.deepEqual(c.integrations, []);
    const c2 = await capabilityProjection(h.store, 'capability:applications.compose');
    assert.deepEqual(c2.providers.map((e) => e.record.id), ['product:feltkit']);
  } finally {
    await h.close();
  }
});

test('by integration: the declared boundary and the targets it is authorized for', async () => {
  const h = await harness();
  try {
    await seed(h.store);
    const i = await integrationProjection(h.store, 'integration:ecosystem-dashboard');
    assert.deepEqual(i.boundary, { mode: 'read', scopes: ['registry:read', 'events:read'] });
    assert.deepEqual(i.targets.map((e) => [e.record.id, e.attributes.mode]), [['product:feltdb', 'read'], ['product:feltkit', 'read']]);
    assert.deepEqual(i.integration.document.principal, { type: 'service', id: 'svc_dashboard' });
    assert.equal(await integrationProjection(h.store, 'integration:nothing'), null);
  } finally {
    await h.close();
  }
});

test('journeys: the neighbourhood of a record across relationships, bounded and ordered, with events as leaves', async () => {
  const h = await harness();
  try {
    await seed(h.store);
    const one = await journey(h.store, 'product-version:feltdb@0.21.0', { maxDepth: 1 });
    assert.deepEqual(one.nodes.map((n) => [n.id, n.depth]), [['event:feltdb:rel_0.21.0_000001', 1], ['product-version:feltdb@0.21.0', 0], [FLOW_DB, 1]]);
    assert.equal(one.nodes[0].record, null, 'an event is a reference, not a record');
    assert.deepEqual(one.edges.map((e) => e.type).sort(), ['evidenced-by', 'released-from']);
    assert.equal(one.truncated, false);

    const two = await journey(h.store, 'product-version:feltdb@0.21.0', { maxDepth: 2 });
    assert.ok(two.nodes.some((n) => n.id === 'product:feltdb' && n.depth === 2), 'version -> repository -> product');
    assert.ok(two.nodes.some((n) => n.id === 'product-version:feltdb@0.20.0' && n.depth === 2), 'sibling release through the repository');

    const whole = await journey(h.store, 'integration:ecosystem-dashboard', { maxDepth: 6 });
    assert.ok(whole.nodes.some((n) => n.id === FELTKIT), 'dashboard -> feltkit -> its repository');
    assert.ok(whole.nodes.some((n) => n.id === 'capability:collections.query@1'));
    assert.equal(whole.nodes.length, new Set(whole.nodes.map((n) => n.id)).size);
    assert.deepEqual(whole.nodes.map((n) => n.id), [...whole.nodes.map((n) => n.id)].sort(), 'sorted');

    const bounded = await journey(h.store, 'integration:ecosystem-dashboard', { maxDepth: 6, limit: 3 });
    assert.equal(bounded.nodes.length, 3);
    assert.equal(bounded.truncated, true);
    assert.equal(await journey(h.store, 'product:nothing'), null);
  } finally {
    await h.close();
  }
});

test('snapshot: the whole registry as one deterministic document', async () => {
  const h = await harness();
  try {
    await seed(h.store);
    const s = await snapshot(h.store);
    assert.deepEqual(s.counts, { product: 2, 'product-version': 3, repository: 2, capability: 2, integration: 1, relationship: 12 });
    assert.deepEqual(s.provenance, { reference: 17, observation: 5 });
    assert.deepEqual(s.records.map((r) => r.id), [...s.records.map((r) => r.id)].sort());
    assert.equal(JSON.stringify(await snapshot(h.store)), JSON.stringify(s));
    const relationships = await h.store.relationships();
    assert.equal(relationships.length, 12);
    assert.equal((await h.store.relationships({ type: 'provides' })).length, 3);
    assert.equal((await h.store.relationships({ from: 'product:feltdb', to: 'product:feltdb' })).length, 4, 'from (provides, evidenced-by) or to (repository-of, authorized-for)');
    await assert.rejects(h.store.list({ name: 'FeltDB' }), /cannot filter by name/);
  } finally {
    await h.close();
  }
});
