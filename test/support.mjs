import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createFeltDB } from '@feltdb/core';

import { EventAcceptor, PublisherDirectory, RegistryStore } from '../src/index.mjs';

/** A persisted FeltDB at `path` (a fresh temp directory unless given) that enforces exactly the registry contract. */
export async function openDb(path) {
  const dir = path ?? (await mkdtemp(join(tmpdir(), 'boundry-intel-registry-')));
  const db = createFeltDB({ mode: 'local', namespace: 'boundry-intel-registry', path: dir, access: 'shared' });
  await RegistryStore.prepare(db);
  return { db, path: dir };
}

export async function harness({ path, now } = {}) {
  const { db, path: dir } = await openDb(path);
  const store = new RegistryStore(db, now ? { now } : {});
  const publishers = new PublisherDirectory(db, now ? { now } : {});
  const events = new EventAcceptor(db, publishers, now ? { now } : {});
  return {
    db,
    store,
    publishers,
    events,
    path: dir,
    close: async ({ keep = false } = {}) => { await db.close(); if (!keep) await rm(dir, { recursive: true, force: true }); },
  };
}

/** A valid `boundry.event/1` envelope; override anything. */
export const envelope = (o = {}) => ({
  schema: 'boundry.event/1',
  id: 'evt_00000001',
  type: 'capability.invoked',
  occurredAt: '2026-11-09T10:00:00Z',
  product: { id: 'feltdb', version: '0.21.0' },
  capability: { name: 'collections.query', version: 1 },
  outcome: { status: 'succeeded' },
  ...o,
});

/** A provenance block: a reference to GitHub by default; override anything. */
export const provenance = (overrides = {}) => ({
  kind: 'reference',
  source: { system: 'github', locator: 'https://github.com/rkendel1/flow_db' },
  assertedBy: { type: 'operator', id: 'test-operator' },
  observedAt: '2026-11-09T10:00:00Z',
  ...overrides,
});

export const observation = (overrides = {}) => provenance({ kind: 'observation', source: { system: 'operator' }, ...overrides });

/** Valid documents of every kind; override anything. */
export const docs = {
  product: (o = {}) => ({ schema: 'boundry.registry/1', kind: 'product', productId: 'feltdb', name: 'FeltDB', status: 'preview', provenance: observation(), ...o }),
  version: (o = {}) => ({ schema: 'boundry.registry/1', kind: 'product-version', productId: 'feltdb', version: '0.21.0', releasedAt: '2026-11-01T00:00:00Z', channel: 'release', packages: [{ registry: 'npm', name: '@feltdb/core', version: '0.21.0' }], provenance: provenance({ source: { system: 'npm', locator: 'https://registry.npmjs.org/@feltdb/core/0.21.0' } }), ...o }),
  repository: (o = {}) => ({ schema: 'boundry.registry/1', kind: 'repository', host: 'github.com', owner: 'rkendel1', name: 'flow_db', defaultBranch: 'main', visibility: 'public', provenance: provenance(), ...o }),
  capability: (o = {}) => ({ schema: 'boundry.registry/1', kind: 'capability', name: 'collections.query', version: 1, summary: 'Bounded, indexed query over a collection', provenance: provenance({ source: { system: 'product-manifest', locator: 'https://feltdb.com/.well-known/appport' } }), ...o }),
  integration: (o = {}) => ({ schema: 'boundry.registry/1', kind: 'integration', integrationId: 'ecosystem-dashboard', name: 'Ecosystem dashboard', integrationKind: 'dashboard', boundary: { mode: 'read', scopes: ['registry:read', 'events:read'] }, principal: { type: 'service', id: 'svc_dashboard' }, provenance: observation(), ...o }),
  relationship: (type, from, to, attributes, o = {}) => ({ schema: 'boundry.registry/1', kind: 'relationship', type, from, to, ...(attributes ? { attributes } : {}), provenance: provenance(), ...o }),
};
