/**
 * Read-only inspection of what Boundry Intel holds: the deterministic half of the operator and agent read surface.
 *
 * Everything here is a bounded read through FeltDB's own query contract (`db.query` with equality and range filters,
 * `orderBy`, `limit` and the authority's opaque `cursor`) or through the existing stores' own reads
 * (`EventAcceptor.get`, `PublisherDirectory.list`, `RegistryStore.get/history/relationships`). Nothing here writes, and
 * nothing here takes a query from a caller: every filter is a named, typed field mapped to one FeltDB condition, so no
 * caller can reach a collection, a field or an operator this module does not name.
 *
 * Two things this module says plainly because the system does not record them:
 *
 * - **Refused ingestion is not persisted.** `EventAcceptor` writes nothing for a refusal, on purpose (a wrong or hostile
 *   client must not grow the store). The only record of a refusal is the container log line and the in-process
 *   `IngestionMonitor` below, which is reset when the process restarts. Diagnostics say which one they are reading.
 * - **Nothing collects on a schedule.** Data arrives only when an authenticated publisher posts `boundry.event/1`
 *   envelopes. "Stalled collection" therefore means a publisher that has stopped posting, judged from its own
 *   `lastUsedAt` and the newest event it delivered.
 */
import { BOUNDRY_INTEL_CONTRACT } from './application.mjs';
import { EVENT_COLLECTIONS } from './acceptance.mjs';
import { PUBLISHER_COLLECTIONS } from './publishers.mjs';
import { COLLECTIONS as REGISTRY_COLLECTIONS } from './store.mjs';
import { eventDigest } from './events.mjs';

/** Hard bounds. A page is never larger than `MAX_PAGE`; a count never scans more than `MAX_COUNT` records. */
export const LIMITS = Object.freeze({ DEFAULT_PAGE: 50, MAX_PAGE: 200, MAX_COUNT: 100_000, COUNT_PAGE: 1000, RECENT_REFUSALS: 50 });

/** Default age after which the newest data is called stale, unless the caller names another threshold. */
export const DEFAULT_STALE_AFTER_SECONDS = 24 * 60 * 60;

/**
 * What each collection is, in words a reader needs before trusting a number from it. The field list and indexes are
 * not repeated here: they are read from the one application contract, so this description cannot drift from it.
 */
export const DATASETS = Object.freeze({
  [EVENT_COLLECTIONS.events]: {
    title: 'Accepted events',
    description: 'boundry.event/1 envelopes accepted from authenticated publishers, stored verbatim with their canonical digest. Raw reported observations: the store derives nothing from them.',
    classification: 'raw-observation',
    timeField: 'receivedAt',
    provenanceFields: ['publisherId', 'receivedAt', 'digest', 'schema', 'reference'],
    retention: 'Kept indefinitely. No deletion, expiry or retention sweep exists in this service.',
    sensitivity: 'An envelope may carry actor identifiers (principal, agent, organization, delegation) as asserted by the publisher. No credentials.',
    readVia: ['intel.events.list', 'intel.events.get'],
  },
  [PUBLISHER_COLLECTIONS.publishers]: {
    title: 'Publishers',
    description: 'Authenticated identities allowed to report events, each bound to one product or repository, with scopes, who issued it, revocation and last use.',
    classification: 'identity',
    timeField: 'createdAt',
    provenanceFields: ['createdBy', 'createdAt', 'revokedAt', 'lastUsedAt'],
    retention: 'Kept indefinitely; revocation marks a record, it never deletes it.',
    sensitivity: 'Holds a SHA-256 hash of each key. The hash is never returned by any read in this service.',
    readVia: ['intel.publishers.list'],
  },
  [REGISTRY_COLLECTIONS.records]: {
    title: 'Registry records',
    description: 'Current boundry.registry/1 documents (products, versions, repositories, capabilities, integrations, relationships), each with its provenance.',
    classification: 'normalized-record',
    timeField: 'recordedAt',
    provenanceFields: ['provenanceKind', 'sourceSystem', 'assertedBy', 'observedAt', 'recordedAt', 'digest', 'revision'],
    retention: 'Kept indefinitely; a revision supersedes, it does not delete.',
    sensitivity: 'Statements about products and repositories. No credentials.',
    readVia: ['intel.registry.list', 'intel.registry.get'],
  },
  [REGISTRY_COLLECTIONS.revisions]: {
    title: 'Registry revisions',
    description: 'Superseded versions of registry documents: the history behind each current record.',
    classification: 'historical-snapshot',
    timeField: 'supersededAt',
    provenanceFields: ['recordedAt', 'supersededAt', 'digest', 'revision'],
    retention: 'Kept indefinitely.',
    sensitivity: 'As registry records.',
    readVia: ['intel.registry.get'],
  },
});

/** A caller's mistake, as opposed to a storage failure. The capability layer turns it into `INVALID_INPUT`. */
export class InspectionInputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InspectionInputError';
  }
}

const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const instant = (value, name) => {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !RFC3339.test(value) || Number.isNaN(Date.parse(value))) throw new InspectionInputError(`${name} must be an RFC 3339 timestamp`);
  return new Date(value).toISOString();
};
const pageSize = (limit) => {
  if (limit === undefined) return LIMITS.DEFAULT_PAGE;
  if (!Number.isInteger(limit) || limit < 1 || limit > LIMITS.MAX_PAGE) throw new InspectionInputError(`limit must be an integer from 1 to ${LIMITS.MAX_PAGE}`);
  return limit;
};
const ageSeconds = (iso, now) => (iso ? Math.max(0, Math.round((now.getTime() - Date.parse(iso)) / 1000)) : null);

/** A stored event as an inspector sees it: the acceptor's own view plus the indexed members it already stores. */
const eventView = (record) => ({
  reference: record.reference,
  eventId: record.eventId,
  productId: record.productId,
  productVersion: record.productVersion ?? null,
  type: record.type,
  schema: record.schema,
  occurredAt: record.occurredAt,
  receivedAt: record.receivedAt,
  correlationId: record.correlationId ?? null,
  publisherId: record.publisherId,
  digest: record.digest,
  event: record.event,
});

/** A registry record as an inspector sees it: the document and every provenance column the store records. */
const registryView = (record) => ({
  id: record.registryId,
  kind: record.kind,
  revision: record.revision,
  digest: record.digest,
  recordedAt: record.recordedAt,
  productId: record.productId ?? null,
  provenance: { kind: record.provenanceKind, sourceSystem: record.sourceSystem, assertedBy: record.assertedBy, observedAt: record.observedAt },
  document: record.document,
});

/**
 * Counts what the service saw arrive since this process started. **Not durable**: it exists because a refused request
 * leaves nothing in storage, so without it an operator without host access could not see that publishers are being
 * turned away. It holds no key, no token and no event content — only who (publisher id, when known), what (product and
 * event id), the answer and the issue codes.
 */
export class IngestionMonitor {
  #now;
  #startedAt;
  #tally = { accepted: 0, duplicate: 0, conflict: 0, rejected: 0, unauthorized: 0, unauthenticated: 0, unavailable: 0, invalidRequest: 0 };
  #lastAcceptedAt = null;
  #lastRefusalAt = null;
  #lastUnavailable = null;
  #recent = [];

  constructor({ now = () => new Date() } = {}) {
    this.#now = now;
    this.#startedAt = now().toISOString();
  }

  /** Records the acceptor's per-envelope answers for one request. */
  answers(list, { publisherId = null } = {}) {
    const at = this.#now().toISOString();
    for (const answer of list) {
      if (answer.status in this.#tally) this.#tally[answer.status] += 1;
      if (answer.status === 'accepted') this.#lastAcceptedAt = at;
      if (answer.status === 'accepted' || answer.status === 'duplicate') continue;
      this.#refusal({ at, status: answer.status, publisherId, eventId: answer.id ?? null, issues: (answer.issues ?? []).map((i) => i.code).slice(0, 10) });
    }
  }

  /** Records a request refused before the acceptor saw it (no key, unparseable body, storage failure). */
  request(kind, { code, message } = {}) {
    const at = this.#now().toISOString();
    if (kind in this.#tally) this.#tally[kind] += 1;
    if (kind === 'unavailable') this.#lastUnavailable = { at, code: code ?? null, message: message ? String(message).slice(0, 300) : null };
    this.#refusal({ at, status: kind, publisherId: null, eventId: null, issues: code ? [code] : [] });
  }

  #refusal(entry) {
    this.#lastRefusalAt = entry.at;
    this.#recent.push(entry);
    if (this.#recent.length > LIMITS.RECENT_REFUSALS) this.#recent.shift();
  }

  snapshot() {
    return {
      durable: false,
      since: this.#startedAt,
      tally: { ...this.#tally },
      lastAcceptedAt: this.#lastAcceptedAt,
      lastRefusalAt: this.#lastRefusalAt,
      lastStorageFailure: this.#lastUnavailable,
      recentRefusals: [...this.#recent].reverse(),
    };
  }
}

export class IntelInspector {
  #db;
  #events;
  #publishers;
  #registry;
  #monitor;
  #readiness;
  #service;
  #now;

  /**
   * @param {{
   *   db: import('@feltdb/core').StateFirstDB,
   *   events: import('./acceptance.mjs').EventAcceptor,
   *   publishers: import('./publishers.mjs').PublisherDirectory,
   *   registry: import('./store.mjs').RegistryStore,
   *   monitor?: IngestionMonitor,
   *   readiness?: () => Promise<{ ready: boolean, detail?: string }>,
   *   service?: { name: string, version: string, startedAt: string, storage: object },
   *   now?: () => Date,
   * }} parts
   */
  constructor({ db, events, publishers, registry, monitor, readiness, service, now = () => new Date() }) {
    this.#db = db;
    this.#events = events;
    this.#publishers = publishers;
    this.#registry = registry;
    this.#monitor = monitor ?? null;
    this.#readiness = readiness ?? (async () => ({ ready: true }));
    this.#service = service ?? null;
    this.#now = now;
  }

  /* ------------------------------------------------ primitives ------------------------------------------------ */

  /** Counts a collection's records by paging through it. Bounded: past `MAX_COUNT` it says the count is a floor. */
  async #count(collection) {
    let count = 0;
    let cursor;
    for (;;) {
      const page = await this.#db.query({ collection, limit: LIMITS.COUNT_PAGE, ...(cursor ? { cursor } : {}) });
      count += page.records.length;
      if (count >= LIMITS.MAX_COUNT) return { count: LIMITS.MAX_COUNT, capped: true };
      if (page.exhausted || !page.nextCursor || page.records.length === 0) return { count, capped: false };
      cursor = page.nextCursor;
    }
  }

  async #edge(collection, field, direction) {
    const page = await this.#db.query({ collection, orderBy: [{ field, direction }], limit: 1 });
    return page.records[0]?.[field] ?? null;
  }

  async #collectionStats(collection) {
    const { timeField } = DATASETS[collection];
    const [{ count, capped }, earliest, latest] = await Promise.all([this.#count(collection), this.#edge(collection, timeField, 'asc'), this.#edge(collection, timeField, 'desc')]);
    return { name: collection, count, countCapped: capped, timeField, earliest, latest };
  }

  /* ------------------------------------------------ capabilities ------------------------------------------------ */

  /** Is it up, is storage usable, how much is there, and how fresh is it. */
  async status({ staleAfterSeconds = DEFAULT_STALE_AFTER_SECONDS } = {}) {
    if (!Number.isInteger(staleAfterSeconds) || staleAfterSeconds < 1) throw new InspectionInputError('staleAfterSeconds must be a positive integer');
    const now = this.#now();
    const probe = await this.#readiness();
    const collections = probe.ready ? await Promise.all(Object.keys(DATASETS).map((c) => this.#collectionStats(c))) : [];
    const events = collections.find((c) => c.name === EVENT_COLLECTIONS.events);
    const publishers = probe.ready ? await this.#publishers.list() : [];
    const latestEventAt = events?.latest ?? null;
    const age = ageSeconds(latestEventAt, now);
    return {
      at: now.toISOString(),
      service: this.#service ? { ...this.#service, uptimeSeconds: ageSeconds(this.#service.startedAt, now) } : null,
      storage: { ready: probe.ready, ...(probe.detail ? { detail: probe.detail } : {}), ...(this.#service?.storage ? { configuration: this.#service.storage } : {}) },
      collections,
      ingestion: {
        mode: 'push: authenticated publishers POST boundry.event/1 envelopes to /v1/events; nothing is collected on a schedule',
        lastAcceptedEventAt: latestEventAt,
        publishers: {
          total: publishers.length,
          active: publishers.filter((p) => !p.revokedAt).length,
          revoked: publishers.filter((p) => p.revokedAt).length,
          lastUsedAt: publishers.map((p) => p.lastUsedAt).filter(Boolean).sort().at(-1) ?? null,
        },
        sinceProcessStart: this.#monitor ? this.#monitor.snapshot() : null,
      },
      freshness: {
        latestEventReceivedAt: latestEventAt,
        ageSeconds: age,
        staleAfterSeconds,
        state: !probe.ready ? 'unknown' : latestEventAt === null ? 'empty' : age > staleAfterSeconds ? 'stale' : 'fresh',
      },
    };
  }

  /** Every collection: what it is, its fields and filterable fields from the contract, and how much it holds. */
  async datasets() {
    const stats = await Promise.all(Object.keys(DATASETS).map((c) => this.#collectionStats(c)));
    return {
      application: { name: BOUNDRY_INTEL_CONTRACT.name, contractVersion: BOUNDRY_INTEL_CONTRACT.version },
      datasets: Object.entries(DATASETS).map(([name, meta]) => {
        const spec = BOUNDRY_INTEL_CONTRACT.collections[name];
        const stat = stats.find((s) => s.name === name);
        return {
          name,
          ...meta,
          fields: Object.entries(spec.fields).map(([field, def]) => ({ name: field, type: def.type, required: Boolean(def.required), ...(def.reference ? { references: def.reference } : {}) })),
          indexedFields: [...new Set((spec.indexes ?? []).flatMap((i) => i.fields))],
          count: stat.count,
          countCapped: stat.countCapped,
          earliest: stat.earliest,
          latest: stat.latest,
        };
      }),
    };
  }

  /** Stored events, newest first by default, filtered by named fields only, one bounded page at a time. */
  async listEvents({ productId, type, correlationId, publisherId, receivedAfter, receivedBefore, order = 'newest', limit, cursor } = {}) {
    if (order !== 'newest' && order !== 'oldest') throw new InspectionInputError('order must be newest or oldest');
    const size = pageSize(limit);
    const after = instant(receivedAfter, 'receivedAfter');
    const before = instant(receivedBefore, 'receivedBefore');
    const where = [
      ...(productId !== undefined ? [{ field: 'productId', eq: productId }] : []),
      ...(type !== undefined ? [{ field: 'type', eq: type }] : []),
      ...(correlationId !== undefined ? [{ field: 'correlationId', eq: correlationId }] : []),
      ...(publisherId !== undefined ? [{ field: 'publisherId', eq: publisherId }] : []),
      ...(after ? [{ field: 'receivedAt', gt: after }] : []),
      ...(before ? [{ field: 'receivedAt', lt: before }] : []),
    ];
    const page = await this.#page(EVENT_COLLECTIONS.events, where, [{ field: 'receivedAt', direction: order === 'newest' ? 'desc' : 'asc' }], size, cursor);
    return { events: page.records.map(eventView), nextCursor: page.nextCursor };
  }

  /** One event with its provenance: who sent it, when, and whether the stored bytes still match their digest. */
  async getEvent({ productId, eventId }) {
    const stored = await this.#events.get(productId, eventId);
    if (!stored) return null;
    const recomputed = eventDigest(stored.event);
    const publisher = await this.#publishers.get(stored.publisherId);
    return {
      ...stored,
      provenance: {
        publisher: publisher ?? { publisherId: stored.publisherId, missing: true },
        receivedAt: stored.receivedAt,
        occurredAt: stored.occurredAt,
        trust: 'The envelope is what the publisher reported. Its key proves which publisher sent it; it does not prove the content is true.',
        integrity: { storedDigest: stored.digest, recomputedDigest: recomputed, matches: recomputed === stored.digest },
      },
    };
  }

  /** Current registry records, newest first, filtered by kind or product. */
  async listRegistry({ kind, productId, limit, cursor } = {}) {
    const size = pageSize(limit);
    const where = [...(kind !== undefined ? [{ field: 'kind', eq: kind }] : []), ...(productId !== undefined ? [{ field: 'productId', eq: productId }] : [])];
    const page = await this.#page(REGISTRY_COLLECTIONS.records, where, [{ field: 'recordedAt', direction: 'desc' }], size, cursor);
    return { records: page.records.map(registryView), nextCursor: page.nextCursor };
  }

  /** One registry record with its full revision history and every relationship that names it. */
  async getRegistry({ id }) {
    const [current] = (await this.#db.query({ collection: REGISTRY_COLLECTIONS.records, where: [{ field: 'registryId', eq: id }], limit: 1 })).records;
    if (!current) return null;
    const [history, outgoing, incoming] = await Promise.all([this.#registry.history(id), this.#registry.relationships({ from: id }), this.#registry.relationships({ to: id })]);
    return { record: registryView(current), history, relationships: { outgoing, incoming } };
  }

  /** Publishers, with what each has delivered: the "collectors" of this system. Never the key or its hash. */
  async listPublishers({ productId, staleAfterSeconds = DEFAULT_STALE_AFTER_SECONDS } = {}) {
    const now = this.#now();
    const list = await this.#publishers.list(productId !== undefined ? { productId } : {});
    const publishers = await Promise.all(
      list.map(async (p) => {
        const newest = (await this.#db.query({ collection: EVENT_COLLECTIONS.events, where: [{ field: 'publisherId', eq: p.publisherId }], orderBy: [{ field: 'receivedAt', direction: 'desc' }], limit: 1 })).records[0];
        const lastActivity = [p.lastUsedAt, newest?.receivedAt].filter(Boolean).sort().at(-1) ?? null;
        const state = p.revokedAt ? 'revoked' : lastActivity === null ? 'never-used' : ageSeconds(lastActivity, now) > staleAfterSeconds ? 'idle' : 'active';
        return { ...p, latestEventReceivedAt: newest?.receivedAt ?? null, state };
      }),
    );
    return { publishers, staleAfterSeconds };
  }

  /** Why data might be missing or stale, as findings with the evidence each one rests on. */
  async diagnose({ staleAfterSeconds = DEFAULT_STALE_AFTER_SECONDS } = {}) {
    const findings = [];
    const add = (severity, code, message, evidence = {}) => findings.push({ severity, code, message, evidence });
    const status = await this.status({ staleAfterSeconds });
    if (!status.storage.ready) {
      add('critical', 'STORAGE_UNREADY', 'Storage is not usable: nothing can be read or accepted until it is.', { detail: status.storage.detail ?? null });
      return { at: status.at, findings, ingestion: status.ingestion.sinceProcessStart, notes: NOTES };
    }
    const { publishers } = await this.listPublishers({ staleAfterSeconds });
    const count = (name) => status.collections.find((c) => c.name === name)?.count ?? 0;
    const active = publishers.filter((p) => p.state !== 'revoked');

    if (publishers.length === 0) add('critical', 'NO_PUBLISHERS', 'No publisher has been issued, so nothing can report events. Issue one with POST /v1/publishers (operator).');
    else if (active.length === 0) add('critical', 'ALL_PUBLISHERS_REVOKED', 'Every publisher is revoked, so nothing can report events.', { revoked: publishers.length });
    if (count(EVENT_COLLECTIONS.events) === 0) add(publishers.length ? 'warning' : 'info', 'NO_EVENTS', 'No event has ever been accepted.');
    if (status.freshness.state === 'stale') add('warning', 'DATA_STALE', `The newest event is older than ${staleAfterSeconds} seconds.`, { latestEventReceivedAt: status.freshness.latestEventReceivedAt, ageSeconds: status.freshness.ageSeconds });
    for (const p of active) {
      if (p.state === 'never-used') add('warning', 'PUBLISHER_NEVER_USED', `Publisher ${p.publisherId} (${p.subject}) has never delivered anything.`, { publisherId: p.publisherId, createdAt: p.createdAt });
      if (p.state === 'idle') add('warning', 'PUBLISHER_IDLE', `Publisher ${p.publisherId} (${p.subject}) has been silent for longer than ${staleAfterSeconds} seconds.`, { publisherId: p.publisherId, lastActivity: p.lastUsedAt ?? p.latestEventReceivedAt });
    }
    if (count(REGISTRY_COLLECTIONS.records) === 0) add('info', 'REGISTRY_EMPTY', 'The registry holds no records. The running service exposes no route that writes registry documents; they are written only by code using RegistryStore directly.');

    const seen = status.ingestion.sinceProcessStart;
    if (seen) {
      const refused = seen.tally.rejected + seen.tally.unauthorized + seen.tally.unauthenticated + seen.tally.conflict + seen.tally.invalidRequest;
      if (refused > 0) add('warning', 'REFUSALS_SINCE_START', `${refused} envelope(s) or request(s) were refused since the process started; refusals are not stored.`, { tally: seen.tally, lastRefusalAt: seen.lastRefusalAt });
      if (seen.tally.unavailable > 0) add('critical', 'STORAGE_FAILURES_SINCE_START', `${seen.tally.unavailable} request(s) failed to store since the process started.`, { lastStorageFailure: seen.lastStorageFailure });
    }
    return { at: status.at, findings, ingestion: seen, notes: NOTES };
  }

  /** One page through FeltDB's own cursor. A cursor is bound by FeltDB to the query that produced it. */
  async #page(collection, where, orderBy, limit, cursor) {
    if (cursor !== undefined && (typeof cursor !== 'string' || cursor.length === 0 || cursor.length > 2048)) throw new InspectionInputError('cursor must be the nextCursor of a previous page');
    let page;
    try {
      page = await this.#db.query({ collection, where, orderBy, limit, ...(cursor ? { cursor } : {}) });
    } catch (error) {
      if (cursor && /cursor/i.test(String(error?.message))) throw new InspectionInputError('cursor does not belong to this query; start again without a cursor');
      throw error;
    }
    const records = page.records.filter((r) => where.every((c) => (c.eq === undefined || r[c.field] === c.eq) && (c.gt === undefined || r[c.field] > c.gt) && (c.lt === undefined || r[c.field] < c.lt)));
    return { records, nextCursor: page.exhausted || !page.nextCursor ? null : page.nextCursor };
  }
}

const NOTES = Object.freeze([
  'Refused submissions (invalid, unauthorized, conflicting) are never written to storage; the only record is the container log and the in-process tally, which resets on restart.',
  'Ingestion is push-only: there is no scheduler or collector inside this service. Missing data means a publisher is not posting, or its posts are being refused.',
]);
