/**
 * The registry on FeltDB, through FeltDB's generic primitives only: an application state contract (`defineStateContract`),
 * transactions with `requireAbsent` and `expectedVersion`, a unique constraint, reference fields and equality indexes.
 * FeltDB holds no registry-specific code; this module is the only place that knows what the records mean. The same
 * pattern as the event store in the old `intelligence/` package and `FeltDbFeedbackStore` in AppPort Services.
 *
 * | Collection            | One per                      | Written                                                              |
 * |-----------------------|------------------------------|----------------------------------------------------------------------|
 * | `registry_records`    | registry id                  | once with `requireAbsent`; revised only under compare-and-set        |
 * | `registry_revisions`  | (registry id, revision)      | once, in the same transaction as the revision that superseded it     |
 *
 * These two collections are part of the one Boundry Intel application contract (`application.mjs`), beside the
 * publisher directory's and the event store's.
 *
 * FeltDB record ids may not contain `:`, `/` or `@` (verified against the local runtime), so a record's FeltDB id is a
 * digest of its registry id (`reg_<hex>`); the readable registry id is a unique, indexed field.
 */
import { AtomicTransactionError, ConditionalConflictError, field } from '@feltdb/core';
import { digestOf } from '@appport/protocol';

import { RELATIONSHIP_KIND, documentDigest, kindOfId, validateDocument } from './contract.mjs';

export const COLLECTIONS = Object.freeze({ records: 'registry_records', revisions: 'registry_revisions' });

const optional = (make) => make({ required: false, nullable: true });
const required = (make) => make({ required: true });

/**
 * The registry's collections: every field the store writes, with an equality index for every query it makes. `fromKey` / `toKey` are FeltDB references: the authority refuses a relationship whose endpoint does not exist and
 * refuses deleting an entity that a relationship still names. `toKey` is null for an event reference (events live in
 * the event store, not here).
 */
export const REGISTRY_COLLECTION_SPEC = Object.freeze({
  [COLLECTIONS.records]: {
      fields: {
        registryId: required(field.string),
        schema: required(field.string),
        kind: required(field.string),
        digest: required(field.string),
        revision: required(field.integer),
        recordedAt: required(field.string),
        document: required(field.json),
        provenanceKind: required(field.string),
        sourceSystem: required(field.string),
        assertedBy: required(field.string),
        observedAt: required(field.string),
        productId: optional(field.string),
        relationshipType: optional(field.string),
        fromId: optional(field.string),
        toId: optional(field.string),
        fromKey: optional((o) => field.reference(COLLECTIONS.records, o)),
        toKey: optional((o) => field.reference(COLLECTIONS.records, o)),
      },
      unique: [['registryId']],
      indexes: [
        { name: 'records_by_registry_id', fields: ['registryId'] },
        { name: 'records_by_kind', fields: ['kind'] },
        { name: 'records_by_product', fields: ['productId'] },
        { name: 'records_by_relationship_type', fields: ['relationshipType'] },
        { name: 'records_by_from', fields: ['fromId'] },
        { name: 'records_by_to', fields: ['toId'] },
      ],
    },
    [COLLECTIONS.revisions]: {
      fields: {
        registryId: required(field.string),
        revision: required(field.integer),
        digest: required(field.string),
        recordedAt: required(field.string),
        supersededAt: required(field.string),
        document: required(field.json),
      },
    indexes: [{ name: 'revisions_by_registry_id', fields: ['registryId'] }],
  },
});

const PAGE = 1000;
/** FeltDB id of a registry record: a digest, because FeltDB ids cannot carry the registry id's punctuation. */
export const recordKey = (registryId) => `reg_${digestOf([registryId]).slice('sha256:'.length, 'sha256:'.length + 32)}`;
const revisionKey = (registryId, revision) => `rev_${digestOf([registryId, revision]).slice('sha256:'.length, 'sha256:'.length + 32)}`;
const plain = (value) => JSON.parse(JSON.stringify(value));
const byRegistryId = (a, b) => (a.registryId < b.registryId ? -1 : a.registryId > b.registryId ? 1 : 0);

/** Every record of `collection` whose fields equal `where`, through bounded, index-backed pages. Sorted by registry id. */
async function find(db, collection, where, max = 10_000) {
  const conditions = Object.entries(where).map(([name, eq]) => ({ field: name, eq }));
  const found = [];
  let cursor;
  while (found.length < max) {
    const page = await db.query({ collection, where: conditions, limit: Math.min(PAGE, max - found.length), ...(cursor ? { cursor } : {}) });
    found.push(...page.records.filter((r) => Object.entries(where).every(([k, v]) => r[k] === v)));
    if (page.exhausted || !page.nextCursor || page.records.length === 0) break;
    cursor = page.nextCursor;
  }
  return { records: found.slice(0, max).sort(byRegistryId), truncated: found.length >= max };
}

/** What readers get for a stored record: the document as asserted plus what the registry recorded. Never `__version`. */
function view(record) {
  return {
    id: record.registryId,
    kind: record.kind,
    revision: record.revision,
    digest: record.digest,
    recordedAt: record.recordedAt,
    document: record.document,
  };
}

export class RegistryStore {
  #db;
  #now;

  /**
   * @param {import('@feltdb/core').StateFirstDB} db  a FeltDB on which `boundryIntelStateContract()` is active
   * @param {{ now?: () => Date }} [options]
   */
  constructor(db, options = {}) {
    this.#db = db;
    this.#now = options.now ?? (() => new Date());
  }

  /**
   * Installs the Boundry Intel application contract on a FeltDB that has none yet. Idempotent; returns whether it was
   * installed now. The registry's collections are part of one application contract with the publisher directory's and
   * the event store's (`application.mjs`), because FeltDB governs a store with exactly one contract.
   */
  static async prepare(db) {
    const { prepare } = await import('./application.mjs');
    return prepare(db);
  }

  /* ----------------------------------------------- writes ----------------------------------------------- */

  /**
   * Records a document once. Identity is the derived registry id:
   * - `recorded`: validated and durably committed before this returns;
   * - `unchanged`: the same document (same digest) is already recorded: an idempotent re-assertion;
   * - `conflict`: the id is recorded with different content; nothing written (`current` is what is recorded);
   * - `rejected`: invalid, or a relationship whose endpoint is not recorded; nothing written, with issues.
   * A storage failure throws.
   */
  async assert(document) {
    const checked = validateDocument(document, { now: this.#now() });
    if (!checked.ok) return { status: 'rejected', id: typeof document?.id === 'string' ? document.id : null, issues: checked.issues };
    const value = checked.value;
    const digest = documentDigest(value);
    const key = recordKey(value.id);
    const record = this.#record(value, { digest, revision: 1, recordedAt: this.#now().toISOString() });
    try {
      await this.#db.transaction({ operations: [{ collection: COLLECTIONS.records, id: key, requireAbsent: true, value: { id: key, ...record } }] });
      return { status: 'recorded', id: value.id, digest, revision: 1 };
    } catch (error) {
      if (error instanceof ConditionalConflictError) {
        const existing = await this.#db.collection(COLLECTIONS.records).get(key);
        if (existing?.digest === digest) return { status: 'unchanged', id: value.id, digest, revision: existing.revision };
        return { status: 'conflict', id: value.id, digest, current: existing ? view(existing) : null, issues: [{ code: 'registry.id.reused', pointer: '', message: 'this registry id is recorded with different content; revise it with the current digest' }] };
      }
      const dangling = danglingReference(error);
      if (dangling) return { status: 'rejected', id: value.id, issues: [dangling] };
      throw error;
    }
  }

  /**
   * Replaces a recorded document with a new assertion about the same thing. The caller names the digest it read
   * (`expectedDigest`): if the record changed since, nothing is written and the answer is `conflict`. The superseded
   * version is kept in `registry_revisions` in the same transaction, so history is never lost.
   */
  async revise(document, { expectedDigest }) {
    if (typeof expectedDigest !== 'string') throw new TypeError('expectedDigest is required');
    const checked = validateDocument(document, { now: this.#now() });
    if (!checked.ok) return { status: 'rejected', id: typeof document?.id === 'string' ? document.id : null, issues: checked.issues };
    const value = checked.value;
    const key = recordKey(value.id);
    const existing = await this.#db.collection(COLLECTIONS.records).get(key);
    if (!existing) return { status: 'missing', id: value.id, issues: [{ code: 'registry.id.unknown', pointer: '/id', message: 'nothing is recorded under this id; assert it first' }] };
    if (existing.digest !== expectedDigest) return { status: 'conflict', id: value.id, current: view(existing), issues: [{ code: 'registry.digest.stale', pointer: '', message: 'the recorded document differs from the one the revision was based on' }] };
    const digest = documentDigest(value);
    if (digest === existing.digest) return { status: 'unchanged', id: value.id, digest, revision: existing.revision };
    const now = this.#now().toISOString();
    const { __version, id: _ignored, ...prior } = existing;
    const revision = existing.revision + 1;
    const record = this.#record(value, { digest, revision, recordedAt: now });
    const revisionId = revisionKey(value.id, existing.revision);
    try {
      await this.#db.transaction({
        operations: [
          { collection: COLLECTIONS.records, id: key, expectedVersion: __version, value: { id: key, ...record } },
          { collection: COLLECTIONS.revisions, id: revisionId, requireAbsent: true, value: { id: revisionId, registryId: value.id, revision: prior.revision, digest: prior.digest, recordedAt: prior.recordedAt, supersededAt: now, document: prior.document } },
        ],
      });
      return { status: 'revised', id: value.id, digest, revision };
    } catch (error) {
      if (error instanceof ConditionalConflictError) {
        const current = await this.#db.collection(COLLECTIONS.records).get(key);
        return { status: 'conflict', id: value.id, current: current ? view(current) : null, issues: [{ code: 'registry.digest.stale', pointer: '', message: 'the record changed while the revision was being written' }] };
      }
      const dangling = danglingReference(error);
      if (dangling) return { status: 'rejected', id: value.id, issues: [dangling] };
      throw error;
    }
  }

  /** Asserts documents in order (entities before the relationships that name them). One result per document. */
  async assertAll(documents) {
    const results = [];
    for (const document of documents) results.push(await this.assert(document));
    return results;
  }

  #record(value, { digest, revision, recordedAt }) {
    const document = plain({ ...value, provenance: { ...value.provenance, recordedAt } });
    const relationship = value.kind === RELATIONSHIP_KIND;
    return {
      registryId: value.id,
      schema: value.schema,
      kind: value.kind,
      digest,
      revision,
      recordedAt,
      document,
      provenanceKind: value.provenance.kind,
      sourceSystem: value.provenance.source.system,
      assertedBy: `${value.provenance.assertedBy.type}:${value.provenance.assertedBy.id}`,
      observedAt: value.provenance.observedAt,
      productId: value.productId ?? null,
      relationshipType: relationship ? value.type : null,
      fromId: relationship ? value.from : null,
      toId: relationship ? value.to : null,
      fromKey: relationship ? recordKey(value.from) : null,
      toKey: relationship && kindOfId(value.to) !== 'event' ? recordKey(value.to) : null,
    };
  }

  /* ----------------------------------------------- reads ----------------------------------------------- */

  /** The current record under a registry id, or null. */
  async get(registryId) {
    const record = await this.#db.collection(COLLECTIONS.records).get(recordKey(registryId));
    return record ? view(record) : null;
  }

  /** Current records, filtered by equal fields (`kind`, `productId`, `relationshipType`, `fromId`, `toId`); sorted by id. */
  async list(where = {}, { limit = 10_000 } = {}) {
    const allowed = ['kind', 'productId', 'relationshipType', 'fromId', 'toId'];
    for (const name of Object.keys(where)) if (!allowed.includes(name)) throw new TypeError(`cannot filter by ${name}`);
    const { records, truncated } = await find(this.#db, COLLECTIONS.records, where, limit);
    return { records: records.map(view), truncated };
  }

  /** Relationships touching an id: those from it, those to it, or both; optionally of one type. Sorted by id. */
  async relationships({ from, to, type } = {}) {
    const where = type ? { relationshipType: type } : {};
    const sets = [];
    if (from !== undefined) sets.push((await find(this.#db, COLLECTIONS.records, { ...where, fromId: from })).records);
    if (to !== undefined) sets.push((await find(this.#db, COLLECTIONS.records, { ...where, toId: to })).records);
    if (from === undefined && to === undefined) sets.push((await find(this.#db, COLLECTIONS.records, { kind: RELATIONSHIP_KIND, ...where })).records);
    const seen = new Map();
    for (const record of sets.flat()) seen.set(record.registryId, record);
    return [...seen.values()].sort(byRegistryId).map(view);
  }

  /** Superseded versions of a record, oldest first, then the current one. */
  async history(registryId) {
    const current = await this.get(registryId);
    if (!current) return [];
    const { records } = await find(this.#db, COLLECTIONS.revisions, { registryId });
    return [...records.sort((a, b) => a.revision - b.revision).map((r) => ({ id: r.registryId, kind: r.document.kind, revision: r.revision, digest: r.digest, recordedAt: r.recordedAt, supersededAt: r.supersededAt, document: r.document })), current];
  }
}

/** The FeltDB reference violation a dangling relationship endpoint raises, as a registry issue; null for anything else. */
function danglingReference(error) {
  if (!(error instanceof AtomicTransactionError)) return null;
  const details = error.details;
  const violation = error.violation ?? error.violations?.[0] ?? (details?.rule ? details : details?.violation);
  if (violation?.rule !== 'reference') return null;
  return { code: 'registry.relationship.dangling', pointer: violation.field === 'toKey' ? '/to' : '/from', message: 'names a registry id that is not recorded' };
}
