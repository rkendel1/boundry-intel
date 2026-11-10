import assert from 'node:assert/strict';
import test from 'node:test';

import { KINDS, RELATIONSHIP_TYPES, documentDigest, eventReference, isRegistryId, kindOfId, registryIdOf, validateDocument } from '../src/contract.mjs';
import { docs, observation, provenance } from './support.mjs';

const codes = (result) => (result.ok ? [] : result.issues.map((i) => i.code));
const pointers = (result) => (result.ok ? [] : result.issues.map((i) => i.pointer));

test('every kind has a valid form and a derived, stable id', () => {
  const valid = {
    product: docs.product(),
    'product-version': docs.version(),
    repository: docs.repository(),
    capability: docs.capability(),
    integration: docs.integration(),
    relationship: docs.relationship('repository-of', 'repository:github.com/rkendel1/flow_db', 'product:feltdb', { role: 'primary' }),
  };
  assert.deepEqual(Object.keys(valid).sort(), [...KINDS].sort());
  const ids = {};
  for (const [kind, document] of Object.entries(valid)) {
    const result = validateDocument(document);
    assert.deepEqual(codes(result), [], kind);
    assert.equal(result.id, registryIdOf(document));
    assert.equal(result.value.id, result.id);
    assert.ok(isRegistryId(result.id), result.id);
    assert.equal(kindOfId(result.id), kind);
    ids[kind] = result.id;
  }
  assert.deepEqual(ids, {
    product: 'product:feltdb',
    'product-version': 'product-version:feltdb@0.21.0',
    repository: 'repository:github.com/rkendel1/flow_db',
    capability: 'capability:collections.query@1',
    integration: 'integration:ecosystem-dashboard',
    relationship: ids.relationship,
  });
  assert.match(ids.relationship, /^relationship:repository-of:[0-9a-f]{16}$/);
  // The relationship id depends only on (type, from, to), not on attributes or provenance.
  assert.equal(registryIdOf(docs.relationship('repository-of', 'repository:github.com/rkendel1/flow_db', 'product:feltdb', { role: 'mirror' }, { provenance: observation() })), ids.relationship);
  // A supplied id must be the derived one.
  assert.deepEqual(codes(validateDocument({ ...docs.product(), id: 'product:feltdb' })), []);
  assert.deepEqual(codes(validateDocument({ ...docs.product(), id: 'product:other' })), ['registry.id.mismatch']);
});

test('the contract is closed: unknown members, unknown kinds and unsupported schemas are refused', () => {
  assert.deepEqual(codes(validateDocument(docs.product({ description: 'a long essay' }))), ['registry.field.unknown']);
  assert.deepEqual(pointers(validateDocument(docs.product({ description: 'x' }))), ['/description']);
  assert.deepEqual(codes(validateDocument(docs.product({ kind: 'service' }))), ['registry.enum.invalid']);
  assert.deepEqual(codes(validateDocument(docs.product({ kind: undefined }))), ['registry.field.required']);
  assert.deepEqual(codes(validateDocument(docs.product({ schema: 'boundry.registry/2' }))), ['registry.schema.unsupported']);
  assert.deepEqual(codes(validateDocument(docs.product({ schema: 'registry' }))), ['registry.schema.invalid']);
  assert.deepEqual(codes(validateDocument(docs.product({ schema: undefined }))), ['registry.schema.required']);
  assert.deepEqual(codes(validateDocument('product:feltdb')), ['registry.type']);
  assert.deepEqual(codes(validateDocument(docs.integration({ boundary: { mode: 'read', scopes: ['a:read'], token: 'nope' } }))), ['registry.field.unknown']);
});

test('entity grammars: product ids, versions, repositories, capabilities and integrations', () => {
  assert.deepEqual(codes(validateDocument(docs.product({ productId: 'FeltDB' }))), ['registry.product.invalid']);
  assert.deepEqual(codes(validateDocument(docs.product({ name: '' }))), ['registry.label.invalid']);
  assert.deepEqual(codes(validateDocument(docs.product({ name: 'two\nlines' }))), ['registry.label.invalid']);
  assert.deepEqual(codes(validateDocument(docs.product({ status: 'shipped' }))), ['registry.enum.invalid']);
  assert.deepEqual(codes(validateDocument(docs.product({ homepage: 'http://insecure.example' }))), ['registry.url.invalid']);
  assert.deepEqual(codes(validateDocument(docs.version({ version: '0.21 .0' }))), ['registry.version.invalid']);
  assert.deepEqual(codes(validateDocument(docs.version({ releasedAt: '2026-11-01' }))), ['registry.timestamp.invalid']);
  assert.deepEqual(codes(validateDocument(docs.version({ packages: [] }))), ['registry.array.invalid']);
  assert.deepEqual(codes(validateDocument(docs.version({ packages: [{ registry: 'pypi', name: 'x', version: '1' }] }))), ['registry.enum.invalid']);
  assert.deepEqual(codes(validateDocument(docs.repository({ host: 'gitlab.com' }))), ['registry.enum.invalid']);
  assert.deepEqual(codes(validateDocument(docs.repository({ name: 'a/b' }))), ['registry.repository.invalid']);
  assert.deepEqual(codes(validateDocument(docs.repository({ archived: 'yes' }))), ['registry.type']);
  assert.deepEqual(codes(validateDocument(docs.capability({ name: 'Invoices.Create' }))), ['registry.capability.invalid']);
  assert.deepEqual(codes(validateDocument(docs.capability({ version: 0 }))), ['registry.integer.invalid']);
  assert.deepEqual(codes(validateDocument(docs.capability({ version: undefined }))), []);
  assert.equal(registryIdOf(docs.capability({ version: undefined })), 'capability:collections.query');
  assert.deepEqual(codes(validateDocument(docs.integration({ integrationKind: 'bot' }))), ['registry.enum.invalid']);
  assert.deepEqual(codes(validateDocument(docs.integration({ boundary: { mode: 'admin', scopes: ['a:read'] } }))), ['registry.enum.invalid']);
  assert.deepEqual(codes(validateDocument(docs.integration({ boundary: { mode: 'read', scopes: [] } }))), ['registry.array.invalid']);
  assert.deepEqual(codes(validateDocument(docs.integration({ boundary: { mode: 'read', scopes: ['a:read', 'a:read'] } }))), ['registry.array.invalid']);
  assert.deepEqual(codes(validateDocument(docs.integration({ boundary: { mode: 'read', scopes: ['Repo Read'] } }))), ['registry.scope.invalid']);
  assert.deepEqual(codes(validateDocument(docs.integration({ boundary: undefined }))), ['registry.field.required']);
  assert.deepEqual(codes(validateDocument(docs.integration({ principal: { type: 'robot', id: 'x' } }))), ['registry.enum.invalid']);
});

test('relationships: endpoint kinds, attributes and the event reference grammar', () => {
  const repo = 'repository:github.com/rkendel1/flow_db';
  const ok = (type, from, to, attributes) => assert.deepEqual(codes(validateDocument(docs.relationship(type, from, to, attributes))), [], `${type} ${from} -> ${to}`);
  const bad = (type, from, to, attributes, expected) => assert.deepEqual(codes(validateDocument(docs.relationship(type, from, to, attributes))), expected, `${type} ${from} -> ${to}`);
  ok('repository-of', repo, 'product:feltdb', { role: 'primary' });
  ok('repository-of', repo, 'product:feltdb');
  ok('released-from', 'product-version:feltdb@0.21.0', repo, { tag: 'v0.21.0', commit: 'c72c1be', url: 'https://github.com/rkendel1/flow_db/releases/tag/v0.21.0' });
  ok('provides', 'product:feltdb', 'capability:collections.query@1', { mechanism: 'sdk' });
  ok('provides', 'product-version:feltdb@0.21.0', 'capability:collections.query@1');
  ok('authorized-for', 'integration:ecosystem-dashboard', 'product:feltdb', { mode: 'read' });
  ok('authorized-for', 'integration:ecosystem-dashboard', repo);
  ok('evidenced-by', 'product-version:feltdb@0.21.0', eventReference('feltdb', 'rel_0.21.0_00001'), { eventType: 'product.released', occurredAt: '2026-11-01T00:00:00Z' });

  bad('repository-of', 'product:feltdb', repo, undefined, ['registry.reference.invalid', 'registry.reference.invalid']);
  bad('released-from', 'product-version:feltdb@0.21.0', repo, undefined, ['registry.field.required']);
  bad('released-from', 'product-version:feltdb@0.21.0', repo, { tag: 'v1', commit: 'not-hex' }, ['registry.commit.invalid']);
  bad('provides', 'product:feltdb', 'capability:collections.query@1', { mechanism: 'telepathy' }, ['registry.enum.invalid']);
  bad('provides', 'product:feltdb', 'capability:collections.query@1', { role: 'primary' }, ['registry.field.unknown']);
  bad('authorized-for', 'product:feltdb', 'integration:ecosystem-dashboard', undefined, ['registry.reference.invalid', 'registry.reference.invalid']);
  bad('evidenced-by', 'product:feltdb', 'event:feltdb:short', undefined, ['registry.reference.invalid']);
  bad('evidenced-by', 'product:feltdb', 'product:appport', undefined, ['registry.reference.invalid']);
  bad('evidenced-by', 'product:feltdb', eventReference('feltdb', 'evt_00000001'), { eventType: 'Released' }, ['registry.event-type.invalid']);
  bad('repository-of', repo, repo, undefined, ['registry.reference.invalid', 'registry.relationship.reflexive']);
  bad('owns', repo, 'product:feltdb', undefined, ['registry.enum.invalid']);

  // Between products: what one needs from another, and what is part of another.
  ok('depends-on', 'product:feltkit', 'product:appport', { scope: 'runtime' });
  ok('depends-on', 'product-version:feltkit@0.3.18', 'product-version:appport@1.7.0', { scope: 'runtime' });
  ok('component-of', 'product:boundry-intel', 'product:boundry');
  bad('depends-on', 'product:feltkit', 'product:appport', { scope: 'vibes' }, ['registry.enum.invalid']);
  bad('depends-on', 'product:feltkit', 'repository:github.com/rkendel1/appport', undefined, ['registry.reference.invalid']);
  bad('depends-on', 'product:feltkit', 'product:feltkit', undefined, ['registry.relationship.reflexive']);
  bad('component-of', 'product:boundry-intel', 'product:boundry', { scope: 'runtime' }, ['registry.field.unknown']);
  bad('component-of', 'product-version:feltkit@0.3.18', 'product:boundry', undefined, ['registry.reference.invalid']);

  // Registration: the integration status of a product or repository, and when it was last verified.
  ok('registered-with', repo, 'integration:boundry-github-app', { status: 'verified', method: 'github-app', lastVerifiedAt: '2026-11-10T04:00:00Z' });
  ok('registered-with', 'product:feltdb', 'integration:boundry-github-app', { status: 'pending' });
  ok('registered-with', repo, 'integration:boundry-github-app', { status: 'verified', method: 'publisher-key', publisher: 'a1b2c3d4e5f6' });
  bad('registered-with', repo, 'integration:boundry-github-app', undefined, ['registry.field.required']);
  bad('registered-with', repo, 'integration:boundry-github-app', { status: 'who-knows' }, ['registry.enum.invalid']);
  bad('registered-with', repo, 'integration:boundry-github-app', { status: 'verified', method: 'telepathy' }, ['registry.enum.invalid']);
  bad('registered-with', repo, 'integration:boundry-github-app', { status: 'verified', publisher: 'not-a-publisher-id' }, ['registry.publisher.invalid']);
  bad('registered-with', repo, 'integration:boundry-github-app', { status: 'verified', lastVerifiedAt: 'yesterday' }, ['registry.timestamp.invalid']);
  bad('registered-with', 'capability:collections.query@1', 'integration:boundry-github-app', { status: 'verified' }, ['registry.reference.invalid']);
  bad('registered-with', repo, 'product:feltdb', { status: 'verified' }, ['registry.reference.invalid']);
  // A credential is never a registry document, whatever a caller calls the member.
  assert.deepEqual(
    codes(validateDocument(docs.relationship('registered-with', repo, 'integration:boundry-github-app', { status: 'verified', publisher: 'a1b2c3d4e5f6' }, { note: 'bik_a1b2c3d4e5f6_0123456789012345678901234567890123456789012' }))),
    ['registry.field.unknown'],
  );

  assert.deepEqual(Object.keys(RELATIONSHIP_TYPES), ['repository-of', 'released-from', 'provides', 'authorized-for', 'evidenced-by', 'depends-on', 'component-of', 'registered-with']);
});

test('provenance: required on every document; references point at an authority and say where', () => {
  assert.deepEqual(codes(validateDocument(docs.product({ provenance: undefined }))), ['registry.field.required']);
  assert.deepEqual(codes(validateDocument(docs.product({ provenance: provenance({ kind: 'guess' }) }))), ['registry.enum.invalid']);
  assert.deepEqual(codes(validateDocument(docs.product({ provenance: provenance({ source: { system: 'operator', locator: 'x' } }) }))), ['registry.provenance.authority']);
  assert.deepEqual(codes(validateDocument(docs.product({ provenance: provenance({ source: { system: 'github' } }) }))), ['registry.field.required']);
  assert.deepEqual(pointers(validateDocument(docs.product({ provenance: provenance({ source: { system: 'github' } }) }))), ['/provenance/source/locator']);
  assert.deepEqual(codes(validateDocument(docs.product({ provenance: provenance({ source: { system: 'wikipedia', locator: 'x' } }) }))), ['registry.enum.invalid']);
  assert.deepEqual(codes(validateDocument(docs.product({ provenance: observation({ source: { system: 'boundry.event' } }) }))), [], 'an observation needs no locator');
  assert.deepEqual(codes(validateDocument(docs.product({ provenance: observation({ source: { system: 'github', locator: 'https://github.com/x' } }) }))), [], 'an observation may still name where it looked');
  assert.deepEqual(codes(validateDocument(docs.product({ provenance: provenance({ assertedBy: { type: 'llm', id: 'model' } }) }))), ['registry.enum.invalid']);
  assert.deepEqual(codes(validateDocument(docs.product({ provenance: provenance({ assertedBy: undefined }) }))), ['registry.field.required']);
  assert.deepEqual(codes(validateDocument(docs.product({ provenance: provenance({ observedAt: 'yesterday' }) }))), ['registry.timestamp.invalid']);
  assert.deepEqual(codes(validateDocument(docs.product({ provenance: provenance({ recordedAt: '2026-11-09T10:00:00Z' }) }))), ['registry.provenance.recorded-at.reserved']);
  const now = new Date('2026-11-09T12:00:00Z');
  assert.deepEqual(codes(validateDocument(docs.product({ provenance: observation({ observedAt: '2026-11-09T12:04:00Z' }) }), { now })), []);
  assert.deepEqual(codes(validateDocument(docs.product({ provenance: observation({ observedAt: '2026-11-09T12:06:00Z' }) }), { now })), ['registry.observed-at.future']);
});

test('credentials are refused anywhere, without echoing them', () => {
  const secret = 'Bearer abcdefghijklmnopqrstuvwxyz012345';
  const result = validateDocument(docs.integration({ contact: secret }));
  assert.deepEqual(codes(result), ['registry.sensitive-content']);
  assert.ok(!JSON.stringify(result).includes(secret));
});

test('digests: the same assertion digests the same; recordedAt and member order do not count; content does', () => {
  const a = docs.product();
  const b = { provenance: { ...a.provenance, recordedAt: '2026-11-09T12:00:00Z' }, name: a.name, status: a.status, productId: a.productId, kind: a.kind, schema: a.schema };
  assert.equal(documentDigest(a), documentDigest(b));
  assert.match(documentDigest(a), /^sha256:[0-9a-f]{64}$/);
  assert.notEqual(documentDigest(a), documentDigest(docs.product({ name: 'FeltDB (renamed)' })));
  assert.notEqual(documentDigest(a), documentDigest(docs.product({ provenance: observation({ observedAt: '2026-11-09T11:00:00Z' }) })), 'provenance is part of the assertion');
});
