/**
 * The read surface of Boundry Intel as an AppPort application: one set of typed, versioned capabilities that serves
 * operators (the CLI, over AppPort HTTP) and agents (MCP, projected from the same manifest by `@appport/mcp`).
 *
 * **AppPort is the contract; this module only declares it.** Validation of input and output, authorization, timeouts,
 * error sanitization and the manifest are `@appport/core`'s. Every capability here is an `observation` that requires the
 * `intel.read` permission and calls exactly one `IntelInspector` read. There is no capability that writes, and none that
 * accepts a query, a collection name or a field name from the caller.
 *
 * **Identity is the service's existing bearer credentials**, not a new identity system: the operator token (which already
 * guards publisher issuance) and an optional reader token that can do nothing *but* read. Both are checked with the
 * same constant-time comparison.
 *
 * **What is verified and what is claimed are kept apart.** The token proves which *credential* was used (`operator` or
 * `reader`); it does not prove which person or agent holds it, because a token can be shared. The `Boundry-Operator`
 * header is required, but it is a label the caller chooses. So the AppPort principal is the credential
 * (`credential:reader`), the label travels as `attributes.claimedName`, and the audit line records both under those
 * names. Per-holder verified identity needs one credential per holder; until then the log says what it actually knows.
 */
import { timingSafeEqual } from 'node:crypto';

import { createApplication, defineCapability } from '@appport/core';
import { permissionAuthorizer } from '@appport/authorization';
import { AppPortError } from '@appport/protocol';
import { fromJSONSchema } from '@appport/schema';

import { InspectionInputError, LIMITS } from './inspection.mjs';

export const APPLICATION_ID = 'com.boundry.intel';
export const READ_PERMISSION = 'intel.read';
const TIMEOUT_MS = 20_000;

/* ------------------------------------------------ schemas ------------------------------------------------ */

const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const str = (description, extra = {}) => ({ type: 'string', description, ...extra });
const id = (description) => str(description, { minLength: 1, maxLength: 300 });
const ts = (description) => str(description, { format: 'date-time' });
const nullable = (schema) => ({ anyOf: [schema, { type: 'null' }] });
const limit = { type: 'integer', minimum: 1, maximum: LIMITS.MAX_PAGE, description: `Page size, 1–${LIMITS.MAX_PAGE} (default ${LIMITS.DEFAULT_PAGE}).` };
const cursor = str('The nextCursor of the previous page, with the same filters. Omit for the first page.', { minLength: 1, maxLength: 2048 });
const stale = { type: 'integer', minimum: 1, maximum: 31_536_000, description: 'Age in seconds after which data or a publisher counts as stale (default 86400).' };
const open = { type: 'object', additionalProperties: true };

const EVENT = obj(
  {
    reference: str('Stable reference: boundry-event://<product>/<event id>.'),
    eventId: str('The envelope id, unique within its product.'),
    productId: str('The product the event is about.'),
    productVersion: nullable(str('Product version as reported.')),
    type: str('boundry.event/1 event type.'),
    schema: str('Envelope schema, boundry.event/1.'),
    occurredAt: ts('When the publisher says it happened.'),
    receivedAt: ts('When this service accepted and committed it.'),
    correlationId: nullable(str('Correlation id from the envelope context.')),
    publisherId: str('The authenticated publisher that sent it.'),
    digest: str('Canonical SHA-256 digest of the envelope at acceptance.'),
    event: { ...open, description: 'The envelope exactly as accepted.' },
  },
  ['reference', 'eventId', 'productId', 'type', 'occurredAt', 'receivedAt', 'publisherId', 'digest', 'event'],
);
EVENT.additionalProperties = true;

const schema = (s) => fromJSONSchema(s);

/* ------------------------------------------------ capabilities ------------------------------------------------ */

/** Maps an inspector call into AppPort's error vocabulary: a caller mistake is INVALID_INPUT, absence is NOT_FOUND. */
const run = async (fn) => {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof InspectionInputError) throw new AppPortError('INVALID_INPUT', error.message);
    throw error;
  }
};
const found = (value, what) => {
  if (value === null || value === undefined) throw new AppPortError('NOT_FOUND', `no such ${what}`);
  return value;
};

/**
 * The capability definitions over an inspector. `onRead` is told about every successful read (capability and caller),
 * so the host can log data access without this module knowing about logs.
 */
export function intelCapabilities(inspector, { onRead = () => {} } = {}) {
  const read = (name, description, input, output, handler) =>
    defineCapability({
      name,
      version: 1,
      description,
      input: schema(input),
      output: schema(output),
      authorization: [READ_PERMISSION],
      effect: 'observation',
      timeoutMs: TIMEOUT_MS,
      handler: async (args, context) => {
        const result = await run(() => handler(args ?? {}));
        // `authenticated` is what the token proved; `claimedName` is what the caller said. Never merged.
        onRead({ capability: name, authenticated: context.principal?.id ?? null, claimedName: context.principal?.attributes?.claimedName ?? null, requestId: context.requestId });
        return result;
      },
    });

  return [
    read(
      'intel.status',
      'Service health, storage readiness, record counts per dataset, the newest accepted event, publisher activity, and data freshness. Start here.',
      obj({ staleAfterSeconds: stale }),
      { ...open, required: ['at', 'storage', 'collections', 'ingestion', 'freshness'] },
      (args) => inspector.status(args),
    ),
    read(
      'intel.datasets.list',
      'Every dataset Boundry Intel stores: what it represents, whether it is raw observation, identity, normalized record or history, its fields and filterable fields, retention, sensitivity, record count and time range.',
      obj({}),
      { ...open, required: ['datasets'] },
      () => inspector.datasets(),
    ),
    read(
      'intel.events.list',
      'Accepted boundry.event/1 events, newest first by default, filtered only by the named fields, one bounded page at a time. Follow nextCursor (with the same filters) for the next page; null means the end.',
      obj({
        productId: id('Only events about this product.'),
        type: id('Only events of this type, e.g. capability.invoked.'),
        correlationId: id('Only events with this correlation id.'),
        publisherId: id('Only events sent by this publisher.'),
        receivedAfter: ts('Only events accepted strictly after this instant.'),
        receivedBefore: ts('Only events accepted strictly before this instant.'),
        order: { type: 'string', enum: ['newest', 'oldest'], description: 'By acceptance time (default newest).' },
        limit,
        cursor,
      }),
      obj({ events: { type: 'array', items: EVENT }, nextCursor: nullable(str('Opaque cursor for the next page.')) }, ['events', 'nextCursor']),
      (args) => inspector.listEvents(args),
    ),
    read(
      'intel.events.get',
      'One event by product and event id, with its provenance: the publisher that sent it, when it was accepted, and whether the stored envelope still matches its digest.',
      obj({ productId: id('The product id.'), eventId: id('The event id.') }, ['productId', 'eventId']),
      { ...open, required: ['reference', 'event', 'provenance'] },
      async (args) => found(await inspector.getEvent(args), 'event'),
    ),
    read(
      'intel.registry.list',
      'Current registry records (products, versions, repositories, capabilities, integrations, relationships), newest first, with provenance. Paged like intel.events.list.',
      obj({
        kind: { type: 'string', enum: ['product', 'product-version', 'repository', 'capability', 'integration', 'relationship'], description: 'Only records of this kind.' },
        productId: id('Only records about this product.'),
        limit,
        cursor,
      }),
      obj({ records: { type: 'array', items: open }, nextCursor: nullable(str('Opaque cursor for the next page.')) }, ['records', 'nextCursor']),
      (args) => inspector.listRegistry(args),
    ),
    read(
      'intel.registry.get',
      'One registry record by registry id, with every earlier revision and every relationship that names it.',
      obj({ id: id('Registry id, e.g. product:feltdb.') }, ['id']),
      { ...open, required: ['record', 'history', 'relationships'] },
      async (args) => found(await inspector.getRegistry(args), 'registry record'),
    ),
    read(
      'intel.publishers.list',
      'The publishers that report events (the sources of all event data): subject, scopes, who issued them, revocation, last use, newest event delivered, and whether each is active, idle, never used or revoked. Never returns keys or key hashes.',
      obj({ productId: id('Only publishers bound to this product.'), staleAfterSeconds: stale }),
      { ...open, required: ['publishers'] },
      (args) => inspector.listPublishers(args),
    ),
    read(
      'intel.diagnostics',
      'Why data might be missing or stale: storage failures, no or revoked publishers, publishers never used or gone idle, stale data, empty registry, and submissions refused since the process started. Each finding carries its evidence.',
      obj({ staleAfterSeconds: stale }),
      { ...open, required: ['findings'] },
      (args) => inspector.diagnose(args),
    ),
  ];
}

/** The AppPort application over the read capabilities. */
export function createIntelApplication(inspector, { version = '0.0.0', onRead } = {}) {
  return createApplication({
    application: {
      id: APPLICATION_ID,
      name: 'Boundry Intel',
      version,
      description: 'Read-only inspection of what Boundry Intel has accepted and recorded: events, publishers, registry records, freshness and ingestion failures.',
    },
    capabilities: intelCapabilities(inspector, { onRead }),
    authorizer: permissionAuthorizer(),
  });
}

/* ------------------------------------------------ authentication ------------------------------------------------ */

function sameToken(presented, expected) {
  if (typeof presented !== 'string' || typeof expected !== 'string') return false;
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

const NAME = /^[^\u0000-\u001f\u007f]{1,200}$/;

/**
 * Resolves a read identity from request headers, or explains why there is none. The operator token and the reader token
 * both grant `intel.read`; nothing here grants anything else, so the read surface cannot issue or revoke a publisher.
 *
 * @returns {{ ok: true, identity: { principal: object, session: object } } | { ok: false, status: number, code: string, message: string }}
 */
export function readerIdentity(headers, { operatorToken, readerToken, now = () => new Date() }) {
  if (!operatorToken && !readerToken) return { ok: false, status: 404, code: 'NOT_FOUND', message: 'no read credential is configured on this service' };
  const header = headers.authorization;
  const match = typeof header === 'string' ? /^Bearer\s+(\S+)$/i.exec(header.trim()) : null;
  const presented = match?.[1];
  const role = presented && operatorToken && sameToken(presented, operatorToken) ? 'operator' : presented && readerToken && sameToken(presented, readerToken) ? 'reader' : null;
  if (!role) return { ok: false, status: 401, code: 'UNAUTHENTICATED', message: 'a reader or operator token is required' };
  const who = typeof headers['boundry-operator'] === 'string' ? headers['boundry-operator'].trim() : '';
  if (!who || !NAME.test(who)) return { ok: false, status: 400, code: 'OPERATOR_UNNAMED', message: 'the Boundry-Operator header must name the caller (one line, at most 200 characters), so every read is attributable' };
  // The principal is the credential, the only thing verified here. The caller's name is an attribute, marked claimed.
  const principal = { id: `credential:${role}`, type: 'service', displayName: who, attributes: { credential: role, claimedName: who, nameVerified: false } };
  return {
    ok: true,
    role,
    claimedName: who,
    identity: { principal, session: { id: `intel:${role}:${who}`, principal, applicationId: APPLICATION_ID, createdAt: now().toISOString(), permissions: [READ_PERMISSION] } },
  };
}
