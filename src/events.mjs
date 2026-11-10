/**
 * The Boundry ecosystem event contract, `boundry.event/1`.
 *
 * A Boundry product (FeltDB, AppPort Services, AppBoundry, FeltKit, …) reports what external agents and applications do
 * with it as structured events. Provenance uses the vocabulary AppPort already established for agent feedback
 * (`appport.feedback/1`, spec §5.3): the same disclosure statuses, the same `context` attributes, the same integration
 * mechanisms, imported from `@appport/protocol` rather than redefined. Nothing here collects prompts or task content.
 *
 * Normative schema: `../schema/boundry-event-1.schema.json`. This module is the reference validator; it is pure and
 * deterministic and returns machine-readable issues (`{ code, pointer, message }`), never echoing a rejected value.
 *
 * **Migrated, not rewritten.** This file and its schema come from `intelligence/src/contract.mjs` and
 * `intelligence/schema/boundry-event-1.schema.json` in rkendel1/boundry (the Phase 0 audit's implementation, commit
 * 3622623), copied unchanged except for this note. The audit's step 1 placed the event contract in this repository
 * once there was something to accept events into; `src/acceptance.mjs` is that. The old repository keeps its copy
 * until its Vercel function is retired, and the two must not drift: `test/events.test.mjs` pins the identity
 * grammars (`PRODUCT_ID`, `IDENTIFIER`, `TIMESTAMP`) against the registry's, which is what makes an event id and a
 * product id mean the same thing in `boundry.registry/1` and `boundry.event/1`.
 */
import {
  FEEDBACK_CATEGORIES,
  FEEDBACK_CONTEXT_ATTRIBUTES,
  FEEDBACK_INTEGRATION_MECHANISMS,
  FEEDBACK_REPORTER_DISCLOSURE_STATUSES,
  FEEDBACK_SEVERITIES,
  FEEDBACK_STATES,
  canonicalize,
  detectSensitive,
  digestOf,
} from '@appport/protocol';

export const EVENT_SCHEMA = 'boundry.event/1';
export const SUPPORTED_EVENT_SCHEMAS = Object.freeze([EVENT_SCHEMA]);

export const EVENT_TYPES = Object.freeze([
  'product.discovered',
  'product.used',
  'capability.invoked',
  'task.completed',
  'task.failed',
  'feedback.submitted',
  'feedback.updated',
  'product.improved',
  'product.released',
]);

/** How an agent found a product. Closed in `/1`. */
export const DISCOVERY_CHANNELS = Object.freeze(['manifest', 'well-known', 'documentation', 'registry', 'package-manager', 'referral', 'other']);
export const OUTCOME_STATUSES = Object.freeze(['succeeded', 'failed', 'partial', 'unknown']);
export const PRINCIPAL_TYPES = Object.freeze(['user', 'service', 'device', 'application']);
/** Counters a source may report. Non-negative integers; closed in `/1`. */
export const COUNTERS = Object.freeze(['operations', 'durationMs', 'items', 'retries', 'bytes']);

/**
 * Identity attributes the emitting product itself can establish, so `verified` is allowed for them: the product
 * authenticated the caller (as an AppPort provider marks the principal `verified` in a feedback receipt). Context
 * attributes are relayed from the agent and keep the reporter statuses only.
 */
export const ACTOR_ATTRIBUTES = Object.freeze(['principal', 'agent', 'organization', 'delegation']);
export const ACTOR_DISCLOSURE_STATUSES = Object.freeze(['verified', ...FEEDBACK_REPORTER_DISCLOSURE_STATUSES]);

/** How sure Boundry can be about who did something. Derived at ingestion, never accepted from a source. */
export const IDENTITY_CLASSES = Object.freeze(['authenticated', 'asserted', 'anonymous', 'unknown']);
export const CONFIDENCE_LEVELS = Object.freeze(['high', 'medium', 'low', 'none']);

export const LIMITS = Object.freeze({
  /** UTF-8 bytes of an event's canonical JSON. */
  eventBytes: 16_384,
  batch: 100,
  /** UTF-8 bytes of a request body. */
  bodyBytes: 1_048_576,
  identifier: 128,
  label: 200,
  version: 64,
  feedbackIds: 50,
  redactions: 50,
  /** Seconds an event's `occurredAt` may be ahead of the receiver's clock. */
  maxSkewSeconds: 300,
});

const PLAIN = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;
const PRODUCT_ID = /^[a-z][a-z0-9-]{1,63}$/;
const VERSION = /^[^\s\u0000-\u001f\u007f]+$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const TASK_CATEGORY = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/;
const POINTER = /^(?:\/(?:[^~/]|~[01])*)+$/;
const EXTENSION_KEY = /^[a-z][a-z0-9]*(?:\.[a-z0-9-]+)+\/[1-9][0-9]*$/;
const esc = (s) => String(s).replace(/~/g, '~0').replace(/\//g, '~1');
const utf8 = (s) => new TextEncoder().encode(s).length;

class Checker {
  issues = [];
  add(code, pointer, message) {
    if (!this.issues.some((i) => i.code === code && i.pointer === pointer)) this.issues.push({ code, pointer, message });
  }
  object(value, pointer, allowed, required) {
    if (!PLAIN(value)) {
      this.add('event.type', pointer, 'must be an object');
      return false;
    }
    for (const key of Object.keys(value)) if (!allowed.includes(key)) this.add('event.field.unknown', `${pointer}/${esc(key)}`, 'is not a member of boundry.event/1');
    for (const key of required) if (value[key] === undefined) this.add('event.field.required', `${pointer}/${esc(key)}`, 'is required');
    return true;
  }
  identifier(value, pointer, min = 1) {
    if (value === undefined) return false;
    if (typeof value !== 'string' || value.length < min || value.length > LIMITS.identifier || !IDENTIFIER.test(value)) {
      this.add('event.identifier.invalid', pointer, `must be ${min}-${LIMITS.identifier} characters of [A-Za-z0-9_.:-]`);
      return false;
    }
    return true;
  }
  label(value, pointer, max = LIMITS.label) {
    if (value === undefined) return false;
    if (typeof value !== 'string' || value.length === 0 || value.length > max || CONTROL.test(value)) {
      this.add('event.label.invalid', pointer, `must be a single-line string of 1-${max} characters`);
      return false;
    }
    return true;
  }
  version(value, pointer) {
    if (value === undefined) return false;
    if (typeof value !== 'string' || value.length === 0 || value.length > LIMITS.version || !VERSION.test(value)) {
      this.add('event.version.invalid', pointer, `must be 1-${LIMITS.version} characters without whitespace`);
      return false;
    }
    return true;
  }
  timestamp(value, pointer) {
    if (value === undefined) return false;
    if (typeof value !== 'string' || !TIMESTAMP.test(value) || Number.isNaN(Date.parse(value))) {
      this.add('event.timestamp.invalid', pointer, 'must be an RFC 3339 date-time with a time zone');
      return false;
    }
    return true;
  }
  oneOf(value, pointer, allowed) {
    if (value === undefined) return false;
    if (typeof value !== 'string' || !allowed.includes(value)) {
      this.add('event.enum.invalid', pointer, `must be one of: ${allowed.join(', ')}`);
      return false;
    }
    return true;
  }
  integer(value, pointer, min = 0) {
    if (value === undefined) return false;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) {
      this.add('event.integer.invalid', pointer, `must be an integer >= ${min}`);
      return false;
    }
    return true;
  }
}

/** A disclosure: `{ status, value? }`, value present iff the status carries one (asserted / verified). */
function disclosure(check, value, pointer, statuses, checkValue) {
  if (!PLAIN(value)) {
    check.add('event.type', pointer, 'must be an object');
    return;
  }
  if (value.status === 'verified' && !statuses.includes('verified')) {
    check.add('event.provenance.verified', `${pointer}/status`, 'relayed provenance cannot be verified by its reporter');
    return;
  }
  if (!check.oneOf(value.status, `${pointer}/status`, statuses)) {
    if (value.status === undefined) check.add('event.field.required', `${pointer}/status`, 'is required');
    return;
  }
  const carries = value.status === 'asserted' || value.status === 'verified';
  check.object(value, pointer, carries ? ['status', 'value'] : ['status'], carries ? ['status', 'value'] : ['status']);
  if (carries && value.value !== undefined) checkValue(value.value, `${pointer}/value`);
}

function named(check, idField, members) {
  return (v, p) => {
    if (!check.object(v, p, members, [idField])) return;
    if (idField === 'id') check.identifier(v.id, `${p}/id`);
    else check.label(v.name, `${p}/name`);
    if (v.name !== undefined && idField === 'id') check.label(v.name, `${p}/name`);
    if (v.version !== undefined) check.version(v.version, `${p}/version`);
  };
}

/** The feedback protocol's `context`, exactly (appport.feedback/1 §5.3): reporter disclosures only. */
function checkContext(check, value) {
  if (!check.object(value, '/context', ['correlationId', ...FEEDBACK_CONTEXT_ATTRIBUTES], [])) return;
  if (value.correlationId !== undefined) check.identifier(value.correlationId, '/context/correlationId', 8);
  const reporter = FEEDBACK_REPORTER_DISCLOSURE_STATUSES;
  if (value.runtime !== undefined) disclosure(check, value.runtime, '/context/runtime', reporter, named(check, 'name', ['name', 'version']));
  if (value.originatingApplication !== undefined) disclosure(check, value.originatingApplication, '/context/originatingApplication', reporter, named(check, 'id', ['id', 'version']));
  if (value.parentAgent !== undefined) disclosure(check, value.parentAgent, '/context/parentAgent', reporter, named(check, 'id', ['id', 'name', 'version']));
  if (value.taskCategory !== undefined) {
    disclosure(check, value.taskCategory, '/context/taskCategory', reporter, (v, p) => {
      if (typeof v !== 'string' || v.length > 64 || !TASK_CATEGORY.test(v)) check.add('event.task-category.invalid', p, 'must be a namespaced label such as invoice.reconciliation, never a description');
    });
  }
  if (value.integrationMechanism !== undefined) disclosure(check, value.integrationMechanism, '/context/integrationMechanism', reporter, (v, p) => check.oneOf(v, p, FEEDBACK_INTEGRATION_MECHANISMS));
}

function checkActor(check, value) {
  if (!check.object(value, '/actor', [...ACTOR_ATTRIBUTES, 'anonymous'], [])) return;
  const statuses = ACTOR_DISCLOSURE_STATUSES;
  if (value.principal !== undefined) {
    disclosure(check, value.principal, '/actor/principal', statuses, (v, p) => {
      if (!check.object(v, p, ['id', 'type'], ['id', 'type'])) return;
      check.identifier(v.id, `${p}/id`);
      check.oneOf(v.type, `${p}/type`, PRINCIPAL_TYPES);
    });
  }
  if (value.agent !== undefined) disclosure(check, value.agent, '/actor/agent', statuses, named(check, 'id', ['id', 'name', 'version']));
  if (value.organization !== undefined) disclosure(check, value.organization, '/actor/organization', statuses, named(check, 'id', ['id']));
  if (value.delegation !== undefined) {
    disclosure(check, value.delegation, '/actor/delegation', statuses, (v, p) => {
      if (!check.object(v, p, ['id', 'depth'], ['id'])) return;
      check.identifier(v.id, `${p}/id`);
      if (v.depth !== undefined) check.integer(v.depth, `${p}/depth`, 1);
    });
  }
  if (value.anonymous !== undefined && value.anonymous !== true) check.add('event.actor.anonymous', '/actor/anonymous', 'is true when present');
  if (value.anonymous === true) {
    for (const attribute of ['principal', 'agent', 'organization']) {
      const status = value[attribute]?.status;
      if (status === 'verified' || status === 'asserted') check.add('event.actor.anonymous-identified', `/actor/${attribute}`, 'an anonymous caller has no stated identity');
    }
  }
}

const feedbackIds = (check, value, pointer, min) => {
  if (!Array.isArray(value) || value.length < min || value.length > LIMITS.feedbackIds) {
    check.add('event.array.invalid', pointer, `must be an array of ${min}-${LIMITS.feedbackIds} feedback ids`);
    return;
  }
  value.forEach((id, i) => check.identifier(id, `${pointer}/${i}`, 8));
};

/** Type-specific `data`. Every member of every type is listed; nothing else is accepted. */
const DATA = {
  'product.discovered': { allowed: ['via'], required: ['via'], check: (c, d) => c.oneOf(d.via, '/data/via', DISCOVERY_CHANNELS) },
  'product.used': { allowed: ['operation'], required: [], check: (c, d) => c.label(d.operation, '/data/operation') },
  'capability.invoked': { allowed: [], required: [] },
  'task.completed': { allowed: ['taskId'], required: [], check: (c, d) => c.identifier(d.taskId, '/data/taskId') },
  'task.failed': { allowed: ['taskId'], required: [], check: (c, d) => c.identifier(d.taskId, '/data/taskId') },
  'feedback.submitted': {
    allowed: ['feedbackId', 'category', 'severity', 'fingerprint'],
    required: ['feedbackId', 'category', 'severity'],
    check: (c, d) => {
      c.identifier(d.feedbackId, '/data/feedbackId', 8);
      c.oneOf(d.category, '/data/category', FEEDBACK_CATEGORIES);
      c.oneOf(d.severity, '/data/severity', FEEDBACK_SEVERITIES);
      if (d.fingerprint !== undefined && !/^sha256:[0-9a-f]{64}$/.test(d.fingerprint)) c.add('event.digest.invalid', '/data/fingerprint', 'must be a sha256 digest');
    },
  },
  'feedback.updated': {
    allowed: ['feedbackId', 'from', 'to', 'sequence'],
    required: ['feedbackId', 'from', 'to', 'sequence'],
    check: (c, d) => {
      c.identifier(d.feedbackId, '/data/feedbackId', 8);
      c.oneOf(d.from, '/data/from', FEEDBACK_STATES);
      c.oneOf(d.to, '/data/to', FEEDBACK_STATES);
      c.integer(d.sequence, '/data/sequence', 1);
    },
  },
  'product.improved': {
    allowed: ['change', 'feedbackIds'],
    required: ['change'],
    check: (c, d) => {
      c.label(d.change, '/data/change');
      if (d.feedbackIds !== undefined) feedbackIds(c, d.feedbackIds, '/data/feedbackIds', 1);
    },
  },
  'product.released': {
    allowed: ['version', 'previousVersion', 'breaking', 'feedbackIds'],
    required: ['version', 'breaking'],
    check: (c, d) => {
      c.version(d.version, '/data/version');
      if (d.previousVersion !== undefined) c.version(d.previousVersion, '/data/previousVersion');
      if (d.breaking !== undefined && typeof d.breaking !== 'boolean') c.add('event.type', '/data/breaking', 'must be a boolean');
      if (d.feedbackIds !== undefined) feedbackIds(c, d.feedbackIds, '/data/feedbackIds', 1);
    },
  },
};

const MEMBERS = ['schema', 'id', 'type', 'occurredAt', 'product', 'capability', 'actor', 'context', 'outcome', 'counters', 'data', 'redactions', 'extensions'];

/**
 * Validates one event. `now` bounds how far in the future `occurredAt` may be. Returns `{ ok: true, value }` or
 * `{ ok: false, issues }`.
 */
export function validateEvent(event, { now = new Date() } = {}) {
  const check = new Checker();
  if (!PLAIN(event)) {
    check.add('event.type', '', 'must be an object');
    return { ok: false, issues: check.issues };
  }
  if (event.schema === undefined) check.add('event.schema.required', '/schema', 'is required');
  else if (!SUPPORTED_EVENT_SCHEMAS.includes(event.schema)) {
    check.add(/^boundry\.event\/[1-9][0-9]*$/.test(String(event.schema)) ? 'event.schema.unsupported' : 'event.schema.invalid', '/schema', `supported: ${SUPPORTED_EVENT_SCHEMAS.join(', ')}`);
  }
  if (check.issues.length) return { ok: false, issues: check.issues };
  try {
    if (utf8(canonicalize(event)) > LIMITS.eventBytes) check.add('event.too-large', '', `must be at most ${LIMITS.eventBytes} bytes of canonical JSON`);
  } catch {
    check.add('event.json.invalid', '', 'must be JSON with finite numbers');
  }
  check.object(event, '', MEMBERS, ['schema', 'id', 'type', 'occurredAt', 'product']);
  check.identifier(event.id, '/id', 8);
  const typeOk = check.oneOf(event.type, '/type', EVENT_TYPES);
  if (check.timestamp(event.occurredAt, '/occurredAt') && Date.parse(event.occurredAt) - now.getTime() > LIMITS.maxSkewSeconds * 1000) {
    check.add('event.occurred-at.future', '/occurredAt', `is more than ${LIMITS.maxSkewSeconds}s in the future`);
  }
  if (event.product !== undefined && check.object(event.product, '/product', ['id', 'version'], ['id', 'version'])) {
    if (event.product.id !== undefined && (typeof event.product.id !== 'string' || !PRODUCT_ID.test(event.product.id))) check.add('event.product.invalid', '/product/id', 'must be a lowercase product id such as feltdb or appport-services');
    check.version(event.product.version, '/product/version');
  }
  if (event.capability !== undefined && check.object(event.capability, '/capability', ['name', 'version'], ['name'])) {
    check.label(event.capability.name, '/capability/name', 128);
    if (event.capability.version !== undefined) check.integer(event.capability.version, '/capability/version', 1);
  }
  if (event.actor !== undefined) checkActor(check, event.actor);
  if (event.context !== undefined) checkContext(check, event.context);
  if (event.outcome !== undefined && check.object(event.outcome, '/outcome', ['status', 'errorCode'], ['status'])) {
    check.oneOf(event.outcome.status, '/outcome/status', OUTCOME_STATUSES);
    if (event.outcome.errorCode !== undefined) check.label(event.outcome.errorCode, '/outcome/errorCode', 128);
  }
  if (event.counters !== undefined && check.object(event.counters, '/counters', COUNTERS, [])) {
    for (const [name, value] of Object.entries(event.counters)) if (COUNTERS.includes(name)) check.integer(value, `/counters/${name}`);
  }
  if (event.redactions !== undefined) {
    if (!Array.isArray(event.redactions) || event.redactions.length > LIMITS.redactions) check.add('event.array.invalid', '/redactions', `must be an array of at most ${LIMITS.redactions} JSON pointers`);
    else event.redactions.forEach((p, i) => { if (typeof p !== 'string' || p.length > 256 || !POINTER.test(p)) check.add('event.pointer.invalid', `/redactions/${i}`, 'must be a JSON pointer'); });
  }
  if (event.extensions !== undefined) {
    if (!PLAIN(event.extensions) || Object.keys(event.extensions).length > 8) check.add('event.extensions.invalid', '/extensions', 'must be an object of at most 8 members');
    else for (const key of Object.keys(event.extensions)) if (!EXTENSION_KEY.test(key) || key.startsWith('boundry.')) check.add('event.extensions.key', `/extensions/${esc(key)}`, 'must be a namespaced, versioned key such as vendor.topic/1');
  }

  if (typeOk) {
    const spec = DATA[event.type];
    if (spec.allowed.length === 0 && event.data !== undefined) check.add('event.field.unknown', '/data', `${event.type} carries no data`);
    else if (event.data !== undefined || spec.required.length) {
      if (event.data === undefined) check.add('event.field.required', '/data', `is required for ${event.type}`);
      else if (check.object(event.data, '/data', spec.allowed, spec.required)) spec.check?.(check, event.data);
    }
    if (event.type === 'capability.invoked') {
      if (event.capability === undefined) check.add('event.field.required', '/capability', 'is required for capability.invoked');
      if (event.outcome === undefined) check.add('event.field.required', '/outcome', 'is required for capability.invoked');
    }
    if (event.type === 'task.completed' && event.outcome?.status !== 'succeeded') check.add('event.outcome.mismatch', '/outcome/status', 'task.completed requires outcome succeeded');
    if (event.type === 'task.failed' && event.outcome?.status !== 'failed') check.add('event.outcome.mismatch', '/outcome/status', 'task.failed requires outcome failed');
  }

  // Credential floor (appport.feedback/1 §5.5), over every string and member name. Never echoes the value.
  for (const [pointer, text] of strings(event)) {
    for (const id of detectSensitive(text)) check.add('event.sensitive-content', pointer, `appears to contain a credential (${id})`);
  }
  return check.issues.length ? { ok: false, issues: check.issues } : { ok: true, value: event };
}

function* strings(value, pointer = '') {
  if (typeof value === 'string') yield [pointer, value];
  else if (Array.isArray(value)) for (let i = 0; i < value.length; i += 1) yield* strings(value[i], `${pointer}/${i}`);
  else if (PLAIN(value)) for (const [k, v] of Object.entries(value)) {
    yield [`${pointer}/${esc(k)}`, k];
    yield* strings(v, `${pointer}/${esc(k)}`);
  }
}

/**
 * Who did it, and how sure Boundry can be. Derived from the event as an authenticated source reported it; a source
 * cannot set it. `verified` actor attributes are the emitting product's own authentication.
 *
 * | identity       | when                                                        | confidence                                  |
 * |----------------|-------------------------------------------------------------|---------------------------------------------|
 * | authenticated  | principal or agent `verified`                                | high                                         |
 * | asserted       | principal or agent `asserted` (and none verified)            | medium with a correlation id, otherwise low  |
 * | anonymous      | `actor.anonymous: true`                                      | none                                         |
 * | unknown        | nothing stated, or only withheld / unavailable               | none                                         |
 */
export function attribute(event) {
  const actor = event.actor ?? {};
  const statuses = [actor.principal?.status, actor.agent?.status];
  let identity = 'unknown';
  if (statuses.includes('verified')) identity = 'authenticated';
  else if (statuses.includes('asserted')) identity = 'asserted';
  else if (actor.anonymous === true) identity = 'anonymous';
  const confidence = identity === 'authenticated' ? 'high' : identity === 'asserted' ? (event.context?.correlationId ? 'medium' : 'low') : 'none';
  const valueOf = (d) => (d && (d.status === 'verified' || d.status === 'asserted') ? d.value : undefined);
  return {
    identity,
    confidence,
    principal: valueOf(actor.principal) ? { ...valueOf(actor.principal), status: actor.principal.status } : null,
    agent: valueOf(actor.agent) ? { id: valueOf(actor.agent).id, status: actor.agent.status } : null,
    organization: valueOf(actor.organization) ? { id: valueOf(actor.organization).id, status: actor.organization.status } : null,
    application: valueOf(event.context?.originatingApplication) ? { id: valueOf(event.context.originatingApplication).id, status: 'asserted' } : null,
  };
}

/** Canonical digest of an event (RFC 8785 + SHA-256, as everywhere in AppPort). Two submissions of one id compare by it. */
export const eventDigest = (event) => digestOf(event);

/** Feedback ids an event concerns (for feedback-to-resolution lookup). */
export function feedbackIdsOf(event) {
  const d = event.data ?? {};
  if (event.type === 'feedback.submitted' || event.type === 'feedback.updated') return [d.feedbackId];
  if ((event.type === 'product.improved' || event.type === 'product.released') && Array.isArray(d.feedbackIds)) return [...new Set(d.feedbackIds)];
  return [];
}
