/**
 * Read-side projections over the registry, for dashboards and other consumers. Every function here reads the store and
 * returns a plain, deterministically ordered value: the same registry state gives the same projection, byte for byte.
 * Nothing here writes, infers or ranks. A dashboard that renders a projection is a view of the registry, never an
 * authority: the registry's records point back at GitHub, product repositories and the event store for the facts.
 */
import { ENTITY_KINDS, RELATIONSHIP_KIND, kindOfId } from './contract.mjs';

const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const compareVersions = (a, b) => {
  const at = a.document.releasedAt ?? '';
  const bt = b.document.releasedAt ?? '';
  return at < bt ? -1 : at > bt ? 1 : byId(a, b);
};
/** A relationship with the record at its other end (or the bare event reference), for embedding in a projection. */
const edge = (relationship, other) => ({
  relationship: relationship.id,
  type: relationship.document.type,
  attributes: relationship.document.attributes ?? {},
  provenance: relationship.document.provenance,
  ...(other && typeof other === 'object' ? { record: other } : { reference: other }),
});

async function resolve(store, relationships, side) {
  const out = [];
  for (const r of relationships) {
    const id = r.document[side];
    out.push(edge(r, kindOfId(id) === 'event' ? id : (await store.get(id)) ?? id));
  }
  const endOf = (e) => e.record?.id ?? e.reference;
  return out.sort((a, b) => (endOf(a) < endOf(b) ? -1 : endOf(a) > endOf(b) ? 1 : a.relationship < b.relationship ? -1 : 1));
}

/** Everything the registry knows about one product: versions, repositories, capabilities, integrations, evidence. */
export async function productProjection(store, productId) {
  const id = `product:${productId}`;
  const product = await store.get(id);
  if (!product) return null;
  const versions = (await store.list({ kind: 'product-version', productId })).records.sort(compareVersions);
  const releases = [];
  for (const version of versions) {
    releases.push({ version, releasedFrom: await resolve(store, await store.relationships({ from: version.id, type: 'released-from' }), 'to'), evidence: await resolve(store, await store.relationships({ from: version.id, type: 'evidenced-by' }), 'to') });
  }
  const provided = [...(await store.relationships({ from: id, type: 'provides' })), ...(await Promise.all(versions.map((v) => store.relationships({ from: v.id, type: 'provides' })))).flat()].sort(byId);
  return {
    product,
    repositories: await resolve(store, await store.relationships({ to: id, type: 'repository-of' }), 'from'),
    versions: releases,
    capabilities: await resolve(store, provided, 'to'),
    integrations: await resolve(store, await store.relationships({ to: id, type: 'authorized-for' }), 'from'),
    evidence: await resolve(store, await store.relationships({ from: id, type: 'evidenced-by' }), 'to'),
  };
}

/** One repository: the products it is a repository of, and the releases cut from it. */
export async function repositoryProjection(store, repositoryId) {
  const repository = await store.get(repositoryId);
  if (!repository) return null;
  return {
    repository,
    products: await resolve(store, await store.relationships({ from: repositoryId, type: 'repository-of' }), 'to'),
    releases: await resolve(store, await store.relationships({ to: repositoryId, type: 'released-from' }), 'from'),
    integrations: await resolve(store, await store.relationships({ to: repositoryId, type: 'authorized-for' }), 'from'),
    evidence: await resolve(store, await store.relationships({ from: repositoryId, type: 'evidenced-by' }), 'to'),
  };
}

/** One capability: who provides it (products or product versions, with the mechanism) and who is authorized for it. */
export async function capabilityProjection(store, capabilityId) {
  const capability = await store.get(capabilityId);
  if (!capability) return null;
  return {
    capability,
    providers: await resolve(store, await store.relationships({ to: capabilityId, type: 'provides' }), 'from'),
    integrations: await resolve(store, await store.relationships({ to: capabilityId, type: 'authorized-for' }), 'from'),
    evidence: await resolve(store, await store.relationships({ from: capabilityId, type: 'evidenced-by' }), 'to'),
  };
}

/** One integration identity: its declared boundary (mode, scopes) and the registry things it is authorized for. */
export async function integrationProjection(store, integrationId) {
  const integration = await store.get(integrationId);
  if (!integration) return null;
  return {
    integration,
    boundary: integration.document.boundary,
    targets: await resolve(store, await store.relationships({ from: integrationId, type: 'authorized-for' }), 'to'),
    evidence: await resolve(store, await store.relationships({ from: integrationId, type: 'evidenced-by' }), 'to'),
  };
}

/**
 * A journey: the connected neighbourhood of one registry id across relationships in both directions, breadth first,
 * to `maxDepth` hops and at most `limit` nodes. Nodes and edges are sorted, so the same state gives the same journey.
 * Event references are leaves (the event store holds the events).
 */
export async function journey(store, startId, { maxDepth = 3, limit = 200 } = {}) {
  const start = await store.get(startId);
  if (!start) return null;
  const nodes = new Map([[startId, { id: startId, kind: start.kind, depth: 0, record: start }]]);
  const edges = new Map();
  let frontier = [startId];
  let truncated = false;
  for (let depth = 1; depth <= maxDepth && frontier.length; depth += 1) {
    const next = [];
    for (const id of frontier) {
      for (const r of await store.relationships({ from: id })) edges.set(r.id, r);
      for (const r of await store.relationships({ to: id })) edges.set(r.id, r);
    }
    for (const r of [...edges.values()].sort(byId)) {
      for (const other of [r.document.from, r.document.to]) {
        if (nodes.has(other)) continue;
        if (nodes.size >= limit) {
          truncated = true;
          continue;
        }
        const record = kindOfId(other) === 'event' ? null : await store.get(other);
        nodes.set(other, { id: other, kind: kindOfId(other), depth, record });
        if (record) next.push(other);
      }
    }
    frontier = next;
  }
  return {
    start: startId,
    nodes: [...nodes.values()].sort(byId),
    edges: [...edges.values()].sort(byId).map((r) => ({ id: r.id, type: r.document.type, from: r.document.from, to: r.document.to, attributes: r.document.attributes ?? {}, provenance: r.document.provenance })),
    truncated,
  };
}

/** The whole registry as one deterministic document: counts per kind and every current record, sorted by id. */
export async function snapshot(store) {
  const records = [];
  for (const kind of [...ENTITY_KINDS, RELATIONSHIP_KIND]) records.push(...(await store.list({ kind })).records);
  records.sort(byId);
  const counts = Object.fromEntries([...ENTITY_KINDS, RELATIONSHIP_KIND].map((k) => [k, 0]));
  const provenance = { reference: 0, observation: 0 };
  for (const r of records) {
    counts[r.kind] += 1;
    provenance[r.document.provenance.kind] += 1;
  }
  return { schema: 'boundry.registry-snapshot/1', counts, provenance, records };
}
