/**
 * Publisher identities: who may tell this registry something, and about what.
 *
 * A **publisher** is an authenticated identity bound to exactly one subject — one product (`product:<id>`) or one
 * repository (`repository:<host>/<owner>/<name>`) — with a closed set of scopes. It is how a Boundry product or the
 * GitHub App registers itself and then speaks: the subject binding is the isolation boundary, checked on every call,
 * so a key issued for one product can never report another's events or assert another's facts.
 *
 * The key is shown once, at issue, and stored only as a SHA-256 hash; nothing here ever returns, logs or echoes it,
 * and comparison is constant-time. A publisher is therefore **not** a `boundry.registry/1` document: a registry
 * document is a readable statement that projections hand out whole, and a credential has no business in one. The
 * public fact that a subject registered — its status and when it was last verified — is the registry's
 * `registered-with` relationship; the credential is here.
 *
 * **Migrated, not rewritten.** The key format (`bik_<12 hex>_<43 base64url>`), the hash-only storage, the
 * constant-time compare and the revocation semantics come from `intelligence/src/store.mjs` in rkendel1/boundry
 * (`issueSource`, `authenticateSource`, `revokeSource`). The format is deliberately unchanged, so a key issued by
 * either implementation is recognized by this one and the old repository's ingestion function can be retired without
 * reissuing keys. What is new: the subject may be a repository (the old binding was a product id only), scopes, and
 * the registration link.
 *
 * **Authority.** `issue` and `revoke` are operator acts. This module does not authenticate the operator: whoever
 * calls it — a future HTTP surface, a CLI, an operator's own script — owns that, exactly as the old implementation's
 * owner token lived in its HTTP layer rather than its store. Nothing here opens a network port or assumes a
 * deployment.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { ConditionalConflictError, field } from '@feltdb/core';

import { isRegistryId, kindOfId } from './contract.mjs';

export const PUBLISHER_COLLECTIONS = Object.freeze({ publishers: 'intel_publishers' });

/** What a publisher may do. Closed: a new scope is a change to this module and its tests, never an ad-hoc string. */
export const PUBLISHER_SCOPES = Object.freeze([
  /** Submit `boundry.event/1` envelopes for the subject product (`src/acceptance.mjs`). */
  'events:write',
  /** Assert registry documents about the subject (the caller enforces the subject check it is given). */
  'registry:assert',
  /** Assert that the subject's registration was verified (`registered-with`, status `verified`). */
  'registration:verify',
]);

/** Subjects a publisher may be bound to. A capability or an integration cannot hold a key: it is not a speaker. */
export const PUBLISHER_SUBJECT_KINDS = Object.freeze(['product', 'repository']);

const KEY = /^bik_([0-9a-f]{12})_([A-Za-z0-9_-]{43})$/;
const LABEL = /^[^\u0000-\u001f\u007f]{1,200}$/;
const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const optional = (make) => make({ required: false, nullable: true });
const required = (make) => make({ required: true });

/**
 * The publisher directory's collection, part of the one Boundry Intel application contract (`application.mjs`).
 * `secretHash` is the only trace of the key. `subject` is a registry id; `productId` is filled only for a product
 * subject, so the acceptance path can check authority with one field comparison and no lookup.
 */
export const PUBLISHER_COLLECTION_SPEC = Object.freeze({
  [PUBLISHER_COLLECTIONS.publishers]: {
      fields: {
        publisherId: required(field.string),
        subject: required(field.string),
        subjectKind: required(field.string),
        productId: optional(field.string),
        name: required(field.string),
        scopes: required(field.json),
        secretHash: required(field.string),
        createdAt: required(field.string),
        createdBy: required(field.string),
        revokedAt: optional(field.string),
        lastUsedAt: optional(field.string),
      },
      unique: [['publisherId']],
    indexes: [
      { name: 'publishers_by_publisher_id', fields: ['publisherId'] },
      { name: 'publishers_by_subject', fields: ['subject'] },
      { name: 'publishers_by_product', fields: ['productId'] },
    ],
  },
});

const PAGE = 1000;

/** Every record whose fields equal `where`, through bounded, index-backed pages. */
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
  return found.slice(0, max);
}

/** What a publisher is, to anyone but its holder: never the hash, never the key. */
const view = (record) => ({
  publisherId: record.publisherId,
  subject: record.subject,
  subjectKind: record.subjectKind,
  productId: record.productId ?? null,
  name: record.name,
  scopes: [...record.scopes],
  createdAt: record.createdAt,
  createdBy: record.createdBy,
  revokedAt: record.revokedAt ?? null,
  lastUsedAt: record.lastUsedAt ?? null,
});

export class PublisherDirectory {
  #db;
  #now;

  /**
   * @param {import('@feltdb/core').StateFirstDB} db the Boundry Intel FeltDB application
   * @param {{ now?: () => Date }} [options]
   */
  constructor(db, options = {}) {
    this.#db = db;
    this.#now = options.now ?? (() => new Date());
  }

  /** Installs the Boundry Intel application contract (every collection, including this one). Idempotent. */
  static async prepare(db) {
    const { prepare } = await import('./application.mjs');
    return prepare(db);
  }

  /**
   * Issues a key bound to one subject. The key is returned **once**; afterwards only its hash exists, so a lost key is
   * revoked and reissued, never recovered. `createdBy` names the operator the caller authenticated.
   *
   * @returns {Promise<{ publisher: object, key: string }>}
   */
  async issue({ subject, name, scopes, createdBy }) {
    if (!isRegistryId(subject, PUBLISHER_SUBJECT_KINDS)) throw new TypeError(`subject must be a registry id of kind ${PUBLISHER_SUBJECT_KINDS.join(' | ')}`);
    if (typeof name !== 'string' || !LABEL.test(name)) throw new TypeError('name must be a single-line string of 1-200 characters');
    if (typeof createdBy !== 'string' || !LABEL.test(createdBy)) throw new TypeError('createdBy must name the operator issuing the key');
    if (!Array.isArray(scopes) || scopes.length === 0 || new Set(scopes).size !== scopes.length || scopes.some((s) => !PUBLISHER_SCOPES.includes(s))) {
      throw new TypeError(`scopes must be a non-empty set of: ${PUBLISHER_SCOPES.join(', ')}`);
    }
    const subjectKind = kindOfId(subject);
    const publisherId = randomBytes(6).toString('hex');
    const key = `bik_${publisherId}_${randomBytes(32).toString('base64url')}`;
    const record = {
      publisherId,
      subject,
      subjectKind,
      productId: subjectKind === 'product' ? subject.slice('product:'.length) : null,
      name,
      scopes: [...scopes].sort(),
      secretHash: sha256(key),
      createdAt: this.#now().toISOString(),
      createdBy,
      revokedAt: null,
      lastUsedAt: null,
    };
    await this.#db.transaction({ operations: [{ collection: PUBLISHER_COLLECTIONS.publishers, id: publisherId, requireAbsent: true, value: { id: publisherId, ...record } }] });
    return { publisher: view(record), key };
  }

  /**
   * The publisher a presented key belongs to, or null: unknown, malformed, or revoked. The hash comparison is
   * constant-time, and a malformed key costs no lookup. Never throws on a bad key: an unauthenticated caller must not
   * be able to tell a wrong key from an unknown one by the shape of the failure.
   */
  async authenticate(presented) {
    const match = typeof presented === 'string' ? KEY.exec(presented) : null;
    if (!match) return null;
    const record = await this.#db.collection(PUBLISHER_COLLECTIONS.publishers).get(match[1]);
    if (!record || record.revokedAt) return null;
    const a = Buffer.from(record.secretHash, 'hex');
    const b = Buffer.from(sha256(presented), 'hex');
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    return view(record);
  }

  /** Records that a publisher was used, for the operator's sake. Best effort: a lost touch never fails the caller. */
  async touch(publisherId) {
    const record = await this.#db.collection(PUBLISHER_COLLECTIONS.publishers).get(publisherId);
    if (!record || record.revokedAt) return;
    const { __version, ...rest } = record;
    await this.#db
      .transaction({ operations: [{ collection: PUBLISHER_COLLECTIONS.publishers, id: publisherId, expectedVersion: __version, value: { ...rest, lastUsedAt: this.#now().toISOString() } }] })
      .catch((error) => {
        if (!(error instanceof ConditionalConflictError)) throw error;
      });
  }

  /** Ends a publisher's authority. Idempotent: revoking a revoked publisher is `true` and writes nothing. */
  async revoke(publisherId, { revokedBy } = {}) {
    if (revokedBy !== undefined && (typeof revokedBy !== 'string' || !LABEL.test(revokedBy))) throw new TypeError('revokedBy must be a single-line string');
    const record = await this.#db.collection(PUBLISHER_COLLECTIONS.publishers).get(publisherId);
    if (!record) return false;
    if (record.revokedAt) return true;
    const { __version, ...rest } = record;
    await this.#db.transaction({ operations: [{ collection: PUBLISHER_COLLECTIONS.publishers, id: publisherId, expectedVersion: __version, value: { ...rest, revokedAt: this.#now().toISOString() } }] });
    return true;
  }

  async get(publisherId) {
    const record = typeof publisherId === 'string' ? await this.#db.collection(PUBLISHER_COLLECTIONS.publishers).get(publisherId) : null;
    return record ? view(record) : null;
  }

  /** Every publisher, or those of one subject or product. Sorted by id, so a listing is stable. */
  async list({ subject, productId } = {}) {
    const where = { ...(subject !== undefined ? { subject } : {}), ...(productId !== undefined ? { productId } : {}) };
    const records = await find(this.#db, PUBLISHER_COLLECTIONS.publishers, where);
    return records.map(view).sort((a, b) => (a.publisherId < b.publisherId ? -1 : 1));
  }
}

/**
 * Whether a publisher may act on a subject with a scope. Pure, so the decision can be read, tested and logged
 * without a database: the publisher must hold the scope, and the thing acted on must be its own subject — the
 * product for a product publisher, the repository for a repository publisher. No authority is inherited through
 * relationships: a key for `repository:github.com/o/n` does not speak for whatever product that repository belongs
 * to, because the registry's own statements about ownership are not a credential.
 */
export function authorizes(publisher, { scope, subject, productId }) {
  if (!publisher || publisher.revokedAt) return { ok: false, reason: 'publisher.revoked' };
  if (!publisher.scopes.includes(scope)) return { ok: false, reason: 'publisher.scope' };
  if (subject !== undefined && subject !== publisher.subject) return { ok: false, reason: 'publisher.subject' };
  if (productId !== undefined && productId !== publisher.productId) return { ok: false, reason: 'publisher.subject' };
  return { ok: true };
}
