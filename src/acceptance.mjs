/**
 * Durable acceptance of `boundry.event/1` envelopes from authenticated publishers.
 *
 * Acceptance is deliberately the whole job of this module: authenticate the publisher, validate the envelope against
 * the versioned contract, check that the envelope is about the publisher's own product, store it once, and answer.
 * **Nothing here interprets an event.** The envelope is stored verbatim beside its digest and the few members needed
 * to find it again — its id, product, type, occurrence time, correlation — and not one derived fact: no attribution,
 * no identity class, no confidence, no feedback links, no counters. Those are a reader's work over the stored bytes
 * (`src/projections.mjs` and whatever a dashboard later asks for), and they are kept out of the write path on
 * purpose: an interpretation that changes must never require rewriting an immutable record of what was reported.
 *
 * The answers a publisher can get, and what each means for its retry:
 *
 * | answer         | meaning                                                                               | retry |
 * |----------------|---------------------------------------------------------------------------------------|-------|
 * | `accepted`     | validated, authorized and **committed** before this returned                          | no    |
 * | `duplicate`    | the same id with the same canonical digest is already stored: an idempotent resend     | no    |
 * | `conflict`     | that id is stored with different content; nothing was written                          | never |
 * | `rejected`     | invalid under `boundry.event/1`; nothing was written, with the issues                  | never |
 * | `unauthorized` | the key is unknown, revoked, lacks `events:write`, or the event is another product's   | never |
 *
 * A refusal writes nothing at all, so a misbehaving or hostile client cannot grow the store by being wrong. A storage
 * failure throws: the caller's surface answers "unavailable" and the publisher resends the same batch, which is safe
 * because identity is `(product.id, id)` and resends are idempotent.
 *
 * **Migrated, not rewritten.** The identity, idempotency and answer semantics come from `IntelligenceStore.ingest`
 * and `#store` in `intelligence/src/store.mjs` (rkendel1/boundry): one record per `(product, event id)` written with
 * `requireAbsent`, a canonical digest deciding duplicate from conflict, and the product binding of the key as the
 * authority check. What changed: the publisher directory is its own module, authority is a scope check as well as a
 * product check, and the derived attribution columns of the old record are gone for the reason above. Left behind
 * with its own reasons (`docs/intelligence-evaluation.md`): the HTTP surface, the emitter, metrics, rate windows and
 * retention sweeping, all of which need a deployment this repository does not assume.
 */
import { ConditionalConflictError, field } from '@feltdb/core';
import { digestOf } from '@appport/protocol';

import { EVENT_SCHEMA, eventDigest, validateEvent } from './events.mjs';
import { eventReference } from './contract.mjs';
import { authorizes } from './publishers.mjs';

export const EVENT_COLLECTIONS = Object.freeze({ events: 'intel_events' });

/** How many envelopes one call may carry. A publisher that has more sends more calls; each is answered on its own. */
export const MAX_BATCH = 100;

const optional = (make) => make({ required: false, nullable: true });
const required = (make) => make({ required: true });

/**
 * The event store's collection, part of the one Boundry Intel application contract (`application.mjs`). `event` is the
 * envelope as it was accepted; `digest` is what makes a resend idempotent. Every other field is copied from the
 * envelope so the store can be searched without parsing every record — none is inferred.
 */
export const EVENT_COLLECTION_SPEC = Object.freeze({
  [EVENT_COLLECTIONS.events]: {
      fields: {
        eventId: required(field.string),
        productId: required(field.string),
        productVersion: optional(field.string),
        type: required(field.string),
        schema: required(field.string),
        occurredAt: required(field.string),
        receivedAt: required(field.string),
        publisherId: required(field.string),
        digest: required(field.string),
        reference: required(field.string),
        correlationId: optional(field.string),
        event: required(field.json),
      },
      unique: [['reference']],
    indexes: [
      { name: 'events_by_reference', fields: ['reference'] },
      { name: 'events_by_product', fields: ['productId'] },
      { name: 'events_by_type', fields: ['type'] },
      { name: 'events_by_correlation', fields: ['correlationId'] },
    ],
  },
});

const PAGE = 1000;
/** FeltDB id of an event: a digest of its identity, because FeltDB ids cannot carry `:` or `/`. */
export const eventKey = (productId, eventId) => `ev_${digestOf([productId, eventId]).slice('sha256:'.length, 'sha256:'.length + 32)}`;
const plain = (value) => JSON.parse(JSON.stringify(value));

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
  return { records: found.slice(0, max), truncated: found.length >= max };
}

/** A stored event as a reader sees it: the envelope as accepted, and how it was accepted. */
const view = (record) => ({
  reference: record.reference,
  eventId: record.eventId,
  productId: record.productId,
  type: record.type,
  occurredAt: record.occurredAt,
  receivedAt: record.receivedAt,
  publisherId: record.publisherId,
  digest: record.digest,
  event: record.event,
});

const unauthorized = (index, id, reason, message) => ({ index, id, status: 'unauthorized', issues: [{ code: reason, pointer: '', message }] });

export class EventAcceptor {
  #db;
  #publishers;
  #now;
  #maxSkewSeconds;

  /**
   * @param {import('@feltdb/core').StateFirstDB} db the Boundry Intel FeltDB application
   * @param {import('./publishers.mjs').PublisherDirectory} publishers the publisher directory that authenticates keys
   * @param {{ now?: () => Date, maxSkewSeconds?: number }} [options]
   */
  constructor(db, publishers, options = {}) {
    this.#db = db;
    this.#publishers = publishers;
    this.#now = options.now ?? (() => new Date());
    this.#maxSkewSeconds = options.maxSkewSeconds ?? 300;
  }

  /** Installs the Boundry Intel application contract (every collection, including this one). Idempotent. */
  static async prepare(db) {
    const { prepare } = await import('./application.mjs');
    return prepare(db);
  }

  /**
   * Accepts a batch from a presented publisher key. One authentication for the batch; one independent answer per
   * envelope, in order, so a publisher learns exactly which of its events landed. An unknown or revoked key answers
   * `unauthorized` for every envelope without touching the store.
   */
  async accept(presentedKey, envelopes) {
    const list = Array.isArray(envelopes) ? envelopes : [envelopes];
    if (list.length === 0) return [];
    if (list.length > MAX_BATCH) throw new TypeError(`a batch carries at most ${MAX_BATCH} envelopes`);
    const publisher = await this.#publishers.authenticate(presentedKey);
    if (!publisher) return list.map((e, index) => unauthorized(index, idOf(e), 'publisher.unknown', 'a valid publisher key is required'));
    return this.acceptAs(publisher, list);
  }

  /**
   * Accepts a batch for a publisher the caller already authenticated (an HTTP surface that authenticates once per
   * connection, a test, an operator's script). The authority checks are made here all the same: a caller cannot pass
   * an authenticated publisher and skip the scope or the product binding.
   */
  async acceptAs(publisher, envelopes) {
    const list = Array.isArray(envelopes) ? envelopes : [envelopes];
    if (list.length > MAX_BATCH) throw new TypeError(`a batch carries at most ${MAX_BATCH} envelopes`);
    const scope = authorizes(publisher, { scope: 'events:write' });
    if (!scope.ok) return list.map((e, index) => unauthorized(index, idOf(e), scope.reason, 'this publisher may not report events'));
    const now = this.#now();
    const answers = [];
    let used = false;
    for (const [index, envelope] of list.entries()) {
      const id = idOf(envelope);
      const checked = validateEvent(envelope, { now });
      if (!checked.ok) {
        answers.push({ index, id, status: 'rejected', issues: checked.issues });
        continue;
      }
      // The isolation boundary: a key speaks for its own product and nothing else. Checked against the key's binding,
      // never against anything the envelope claims about itself.
      const own = authorizes(publisher, { scope: 'events:write', productId: envelope.product.id });
      if (!own.ok) {
        answers.push(unauthorized(index, id, 'event.product.forbidden', 'this publisher may only report events for its own product'));
        continue;
      }
      answers.push({ index, id, ...(await this.#store(publisher, envelope, now)) });
      used = true;
    }
    if (used) await this.#publishers.touch(publisher.publisherId);
    return answers;
  }

  async #store(publisher, envelope, now) {
    const digest = eventDigest(envelope);
    const reference = eventReference(envelope.product.id, envelope.id);
    const key = eventKey(envelope.product.id, envelope.id);
    const record = {
      id: key,
      eventId: envelope.id,
      productId: envelope.product.id,
      productVersion: envelope.product.version ?? null,
      type: envelope.type,
      schema: envelope.schema,
      occurredAt: new Date(envelope.occurredAt).toISOString(),
      receivedAt: now.toISOString(),
      publisherId: publisher.publisherId,
      digest,
      reference,
      correlationId: envelope.context?.correlationId ?? null,
      event: plain(envelope),
    };
    try {
      await this.#db.transaction({ operations: [{ collection: EVENT_COLLECTIONS.events, id: key, requireAbsent: true, value: record }] });
      return { status: 'accepted', reference, digest };
    } catch (error) {
      if (!(error instanceof ConditionalConflictError)) throw error;
      const existing = await this.#db.collection(EVENT_COLLECTIONS.events).get(key);
      if (existing?.digest === digest) return { status: 'duplicate', reference, digest };
      return { status: 'conflict', reference, digest, issues: [{ code: 'event.id.reused', pointer: '/id', message: 'this event id is stored with different content' }] };
    }
  }

  /** One stored event by its `boundry.event/1` identity, or null. */
  async get(productId, eventId) {
    const record = await this.#db.collection(EVENT_COLLECTIONS.events).get(eventKey(productId, eventId));
    return record ? view(record) : null;
  }

  /** Stored events, filtered by the envelope's own members only. Oldest first by occurrence, then by id: stable. */
  async list({ productId, type, correlationId, limit = 1000 } = {}) {
    const where = {
      ...(productId !== undefined ? { productId } : {}),
      ...(type !== undefined ? { type } : {}),
      ...(correlationId !== undefined ? { correlationId } : {}),
    };
    const { records, truncated } = await find(this.#db, EVENT_COLLECTIONS.events, where, limit);
    const events = records
      .map(view)
      .sort((a, b) => (a.occurredAt < b.occurredAt ? -1 : a.occurredAt > b.occurredAt ? 1 : a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0));
    return { events, truncated };
  }

  /** How many events are stored for a product (or in all). Counts records, interprets nothing. */
  async count({ productId } = {}) {
    const { records } = await find(this.#db, EVENT_COLLECTIONS.events, productId !== undefined ? { productId } : {});
    return records.length;
  }
}

const idOf = (envelope) => (typeof envelope?.id === 'string' ? envelope.id : null);

export { EVENT_SCHEMA };
