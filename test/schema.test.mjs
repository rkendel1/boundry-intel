/** The published schema and the reference validator agree on valid documents and on every refusal the schema can express. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { fromJSONSchema } from '@appport/schema';

import { eventReference, validateDocument } from '../src/contract.mjs';
import { docs, observation, provenance } from './support.mjs';

const root = JSON.parse(readFileSync(new URL('../schema/boundry-registry-1.schema.json', import.meta.url), 'utf8'));
const schema = fromJSONSchema(root.$defs.document, root);
const both = (value) => ({ schema: schema.validate(JSON.parse(JSON.stringify(value))).ok, reference: validateDocument(value).ok });

const REPO = 'repository:github.com/rkendel1/flow_db';
const VALID = [
  docs.product(),
  docs.product({ summary: 'Durable state for applications and agents', category: 'Application state', homepage: 'https://feltdb.com', provenance: provenance({ source: { system: 'product-manifest', locator: 'https://feltdb.com/.well-known/appport' } }) }),
  docs.version(),
  docs.version({ releasedAt: undefined, channel: undefined, packages: undefined }),
  docs.repository(),
  docs.repository({ archived: true, defaultBranch: undefined }),
  docs.capability(),
  docs.capability({ version: undefined }),
  docs.integration(),
  docs.integration({ principal: undefined, contact: 'platform@example.test', boundary: { mode: 'read-write', scopes: ['registry:write'], note: 'Writes release references only' } }),
  docs.relationship('repository-of', REPO, 'product:feltdb', { role: 'primary' }),
  docs.relationship('released-from', 'product-version:feltdb@0.21.0', REPO, { tag: 'v0.21.0', commit: 'c72c1be', url: 'https://github.com/rkendel1/flow_db/releases/tag/v0.21.0' }),
  docs.relationship('provides', 'product-version:feltdb@0.21.0', 'capability:collections.query@1', { mechanism: 'sdk' }),
  docs.relationship('authorized-for', 'integration:ecosystem-dashboard', 'capability:collections.query@1'),
  docs.relationship('evidenced-by', 'product:feltdb', eventReference('feltdb', 'evt_00000001'), { eventType: 'product.used', occurredAt: '2026-11-09T10:00:00Z' }, { provenance: observation({ source: { system: 'boundry.event' } }) }),
];

test('the schema accepts what the reference accepts, with and without the derived id', () => {
  for (const [i, document] of VALID.entries()) {
    assert.deepEqual(both(document), { schema: true, reference: true }, `valid #${i} (${document.kind})`);
    const withId = validateDocument(document).value;
    assert.deepEqual(both(withId), { schema: true, reference: true }, `valid #${i} with id`);
  }
});

test('the schema refuses what the reference refuses, wherever the rule is structural', () => {
  const INVALID = [
    docs.product({ productId: 'FeltDB' }),
    docs.product({ extra: 1 }),
    docs.product({ status: 'shipped' }),
    docs.product({ homepage: 'ftp://x' }),
    docs.product({ schema: 'boundry.registry/2' }),
    docs.product({ kind: 'service' }),
    docs.product({ provenance: undefined }),
    docs.product({ provenance: provenance({ source: { system: 'operator', locator: 'x' } }) }),
    docs.product({ provenance: provenance({ source: { system: 'github' } }) }),
    docs.product({ provenance: provenance({ recordedAt: '2026-11-09T10:00:00Z' }) }),
    docs.product({ provenance: provenance({ assertedBy: { type: 'llm', id: 'x' } }) }),
    docs.product({ provenance: provenance({ observedAt: 'yesterday' }) }),
    docs.version({ version: 'with space' }),
    docs.version({ packages: [] }),
    docs.version({ packages: [{ registry: 'pypi', name: 'x', version: '1' }] }),
    docs.repository({ host: 'gitlab.com' }),
    docs.repository({ name: 'a/b' }),
    docs.capability({ name: 'Invoices.Create' }),
    docs.capability({ version: 0 }),
    docs.integration({ boundary: { mode: 'admin', scopes: ['a'] } }),
    docs.integration({ boundary: { mode: 'read', scopes: [] } }),
    docs.integration({ boundary: { mode: 'read', scopes: ['a:read', 'a:read'] } }),
    docs.integration({ boundary: undefined }),
    docs.relationship('repository-of', 'product:feltdb', REPO),
    docs.relationship('released-from', 'product-version:feltdb@0.21.0', REPO),
    docs.relationship('released-from', 'product-version:feltdb@0.21.0', REPO, { tag: 'v1', commit: 'zzz' }),
    docs.relationship('provides', 'product:feltdb', 'capability:collections.query@1', { mechanism: 'telepathy' }),
    docs.relationship('provides', 'product:feltdb', 'capability:collections.query@1', { role: 'primary' }),
    docs.relationship('authorized-for', 'product:feltdb', 'integration:ecosystem-dashboard'),
    docs.relationship('evidenced-by', 'product:feltdb', 'event:feltdb:short'),
    docs.relationship('evidenced-by', 'product:feltdb', 'product:appport'),
    docs.relationship('owns', REPO, 'product:feltdb'),
  ];
  for (const [i, document] of INVALID.entries()) assert.deepEqual(both(document), { schema: false, reference: false }, `invalid #${i}`);
});

test('rules only the reference can express are documented as such', () => {
  // A relationship from a thing to itself, a credential-shaped string, a far-future observedAt and an id that is not the
  // derived one pass the schema (it has no cross-field or content rules) and are refused by the reference validator.
  const reflexive = docs.relationship('authorized-for', 'integration:ecosystem-dashboard', 'integration:ecosystem-dashboard');
  assert.equal(validateDocument(reflexive).ok, false);
  const secret = docs.integration({ contact: 'Bearer abcdefghijklmnopqrstuvwxyz012345' });
  assert.deepEqual(both(secret), { schema: true, reference: false });
  const future = docs.product({ provenance: observation({ observedAt: '2099-01-01T00:00:00Z' }) });
  assert.deepEqual(both(future), { schema: true, reference: false });
  const wrongId = { ...docs.product(), id: 'product:other' };
  assert.deepEqual(both(wrongId), { schema: true, reference: false }, 'a well-formed id that is not the derived one');
  assert.match(root.description, /reference validator/);
});
