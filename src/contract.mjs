/**
 * The Boundry Intel registry contract, `boundry.registry/1`.
 *
 * A registry document is a closed, versioned statement about one thing in the Boundry ecosystem: a product, a product
 * version, a GitHub repository, a capability, an integration identity, or one explicit relationship between two of
 * them. Every document carries provenance: where the statement came from, who or what asserted it, when the source
 * stated it, and whether it is a **reference** to an authority (GitHub, a product repository's release, npm, a product
 * manifest) or an **observation** Boundry made itself. The registry never holds the authority's data: it holds the
 * attributable pointer and what was observed.
 *
 * Grammars shared with `boundry.event/1` (the ecosystem event contract) are copied here character for character so
 * that product ids and event ids mean the same thing in both contracts: `PRODUCT_ID`, `IDENTIFIER`, `VERSION`,
 * `TIMESTAMP`, `LABEL`, `PRINCIPAL_TYPES`. Integration mechanisms are `appport.feedback/1`'s, imported.
 *
 * Normative schema: `../schema/boundry-registry-1.schema.json`. This module is the reference validator: pure,
 * deterministic, machine-readable issues (`{ code, pointer, message }`), never echoing a refused value. No LLM, no I/O.
 */
import { FEEDBACK_INTEGRATION_MECHANISMS, canonicalize, detectSensitive, digestOf } from '@appport/protocol';

export const REGISTRY_SCHEMA = 'boundry.registry/1';
export const SUPPORTED_REGISTRY_SCHEMAS = Object.freeze([REGISTRY_SCHEMA]);

/** Entity kinds, then the one relationship kind. Closed in `/1`. */
export const ENTITY_KINDS = Object.freeze(['product', 'product-version', 'repository', 'capability', 'integration']);
export const RELATIONSHIP_KIND = 'relationship';
export const KINDS = Object.freeze([...ENTITY_KINDS, RELATIONSHIP_KIND]);

/**
 * Relationship types and the kinds they may join. `evidenced-by` points from any entity at an ecosystem event by
 * reference (`event:<productId>:<eventId>`); the event itself stays in the event store.
 */
export const RELATIONSHIP_TYPES = Object.freeze({
  'repository-of': { from: ['repository'], to: ['product'], attributes: ['role'] },
  'released-from': { from: ['product-version'], to: ['repository'], attributes: ['tag', 'commit', 'url'], required: ['tag'] },
  provides: { from: ['product', 'product-version'], to: ['capability'], attributes: ['mechanism'] },
  'authorized-for': { from: ['integration'], to: ['product', 'capability', 'repository'], attributes: ['mode'] },
  'evidenced-by': { from: ENTITY_KINDS, to: ['event'], attributes: ['eventType', 'occurredAt'] },
});
export const REPOSITORY_ROLES = Object.freeze(['primary', 'documentation', 'examples', 'mirror']);
export const ACCESS_MODES = Object.freeze(['read', 'write', 'read-write']);
export const PRODUCT_STATUSES = Object.freeze(['planned', 'in-development', 'preview', 'available', 'deprecated', 'retired']);
export const RELEASE_CHANNELS = Object.freeze(['release', 'prerelease']);
export const REPOSITORY_HOSTS = Object.freeze(['github.com']);
export const REPOSITORY_VISIBILITIES = Object.freeze(['public', 'private']);
export const PACKAGE_REGISTRIES = Object.freeze(['npm']);
export const INTEGRATION_KINDS = Object.freeze(['github-app', 'webhook', 'service', 'agent', 'dashboard', 'operator', 'other']);
/** As in `boundry.event/1` `actor.principal.type`. */
export const PRINCIPAL_TYPES = Object.freeze(['user', 'service', 'device', 'application']);

/** Provenance. `reference` points at an authority and must say where; `observation` is Boundry's own record. */
export const PROVENANCE_KINDS = Object.freeze(['reference', 'observation']);
export const AUTHORITY_SYSTEMS = Object.freeze(['github', 'npm', 'product-repository', 'product-manifest']);
export const OBSERVER_SYSTEMS = Object.freeze(['boundry.event', 'operator', 'integration']);
export const SOURCE_SYSTEMS = Object.freeze([...AUTHORITY_SYSTEMS, ...OBSERVER_SYSTEMS]);
export const ASSERTER_TYPES = Object.freeze(['operator', 'integration', 'product', 'job']);

export const LIMITS = Object.freeze({
  /** UTF-8 bytes of a document's canonical JSON. */
  documentBytes: 16_384,
  identifier: 128,
  label: 200,
  summary: 500,
  version: 64,
  locator: 512,
  scopes: 32,
  packages: 20,
});

/* ------------------------------------------------------------------------------------------------------------------ */
/* Grammars (those marked "as boundry.event/1" are copied from its reference validator, unchanged)                    */
/* ------------------------------------------------------------------------------------------------------------------ */

const PLAIN = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
/** as boundry.event/1 */
export const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;
/** as boundry.event/1 */
export const PRODUCT_ID = /^[a-z][a-z0-9-]{1,63}$/;
/** as boundry.event/1 */
const VERSION = /^[^\s\u0000-\u001f\u007f]+$/;
/** as boundry.event/1 */
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
/** as boundry.event/1 (labels are single-line) */
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const SLUG = /^[a-z][a-z0-9-]{1,63}$/;
const REPOSITORY_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
const CAPABILITY_NAME = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/;
const SCOPE = /^[a-z][a-z0-9_.:-]{0,63}$/;
const COMMIT = /^[0-9a-f]{7,64}$/;
const EVENT_TYPE = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;
const HTTPS_URL = /^https:\/\/[^\s\u0000-\u001f\u007f]+$/;
const esc = (s) => String(s).replace(/~/g, '~0').replace(/\//g, '~1');
const utf8 = (s) => new TextEncoder().encode(s).length;

/* ------------------------------------------------------------------------------------------------------------------ */
/* Stable identifiers                                                                                                 */
/* ------------------------------------------------------------------------------------------------------------------ */

/**
 * The registry id of a document is derived from its natural key, so the same thing asserted twice has the same id:
 *
 * | kind              | id                                                  |
 * |-------------------|-----------------------------------------------------|
 * | product           | `product:<productId>`                               |
 * | product-version   | `product-version:<productId>@<version>`             |
 * | repository        | `repository:<host>/<owner>/<name>`                  |
 * | capability        | `capability:<name>` or `capability:<name>@<version>`|
 * | integration       | `integration:<integrationId>`                       |
 * | relationship      | `relationship:<type>:<digest16 of [from, to]>`      |
 *
 * An ecosystem event is referenced, never stored, as `event:<productId>:<eventId>` (the `boundry.event/1` identity
 * `(product.id, id)`).
 */
export function registryIdOf(document) {
  switch (document?.kind) {
    case 'product': return `product:${document.productId}`;
    case 'product-version': return `product-version:${document.productId}@${document.version}`;
    case 'repository': return `repository:${document.host}/${document.owner}/${document.name}`;
    case 'capability': return `capability:${document.name}${document.version !== undefined ? `@${document.version}` : ''}`;
    case 'integration': return `integration:${document.integrationId}`;
    case 'relationship': return `relationship:${document.type}:${digestOf([document.from, document.to]).slice('sha256:'.length, 'sha256:'.length + 16)}`;
    default: return null;
  }
}

export const eventReference = (productId, eventId) => `event:${productId}:${eventId}`;

/** The kind a registry or event reference id names, from its prefix; null when the prefix is unknown. */
export function kindOfId(id) {
  if (typeof id !== 'string') return null;
  const prefix = id.slice(0, id.indexOf(':'));
  return KINDS.includes(prefix) || prefix === 'event' ? prefix : null;
}

/** Structural check of a registry id or an event reference. The store checks that referenced records exist. */
export function isRegistryId(id, kinds = [...KINDS, 'event']) {
  if (typeof id !== 'string' || id.length > 512) return false;
  const kind = kindOfId(id);
  if (!kind || !kinds.includes(kind)) return false;
  const rest = id.slice(kind.length + 1);
  switch (kind) {
    case 'product': return PRODUCT_ID.test(rest);
    case 'product-version': {
      const at = rest.indexOf('@');
      return at > 0 && PRODUCT_ID.test(rest.slice(0, at)) && VERSION.test(rest.slice(at + 1)) && rest.length - at - 1 <= LIMITS.version;
    }
    case 'repository': {
      const parts = rest.split('/');
      return parts.length === 3 && REPOSITORY_HOSTS.includes(parts[0]) && REPOSITORY_SEGMENT.test(parts[1]) && REPOSITORY_SEGMENT.test(parts[2]);
    }
    case 'capability': {
      const at = rest.indexOf('@');
      const name = at === -1 ? rest : rest.slice(0, at);
      return CAPABILITY_NAME.test(name) && name.length <= LIMITS.identifier && (at === -1 || /^[1-9][0-9]*$/.test(rest.slice(at + 1)));
    }
    case 'integration': return SLUG.test(rest);
    case 'relationship': {
      const sep = rest.indexOf(':');
      return sep > 0 && Object.hasOwn(RELATIONSHIP_TYPES, rest.slice(0, sep)) && /^[0-9a-f]{16}$/.test(rest.slice(sep + 1));
    }
    case 'event': {
      const sep = rest.indexOf(':');
      if (sep <= 0) return false;
      const eventId = rest.slice(sep + 1);
      return PRODUCT_ID.test(rest.slice(0, sep)) && eventId.length >= 8 && eventId.length <= LIMITS.identifier && IDENTIFIER.test(eventId);
    }
    default: return false;
  }
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Validator                                                                                                          */
/* ------------------------------------------------------------------------------------------------------------------ */

class Checker {
  issues = [];
  add(code, pointer, message) {
    if (!this.issues.some((i) => i.code === code && i.pointer === pointer)) this.issues.push({ code, pointer, message });
  }
  object(value, pointer, allowed, required) {
    if (!PLAIN(value)) {
      this.add('registry.type', pointer, 'must be an object');
      return false;
    }
    for (const key of Object.keys(value)) if (!allowed.includes(key)) this.add('registry.field.unknown', `${pointer}/${esc(key)}`, `is not a member of ${REGISTRY_SCHEMA}`);
    for (const key of required) if (value[key] === undefined) this.add('registry.field.required', `${pointer}/${esc(key)}`, 'is required');
    return true;
  }
  pattern(value, pointer, regex, max, code, message) {
    if (value === undefined) return false;
    if (typeof value !== 'string' || value.length === 0 || value.length > max || !regex.test(value)) {
      this.add(code, pointer, message);
      return false;
    }
    return true;
  }
  label(value, pointer, max = LIMITS.label) {
    if (value === undefined) return false;
    if (typeof value !== 'string' || value.length === 0 || value.length > max || CONTROL.test(value)) {
      this.add('registry.label.invalid', pointer, `must be a single-line string of 1-${max} characters`);
      return false;
    }
    return true;
  }
  identifier(value, pointer, min = 1) {
    if (value === undefined) return false;
    if (typeof value !== 'string' || value.length < min || value.length > LIMITS.identifier || !IDENTIFIER.test(value)) {
      this.add('registry.identifier.invalid', pointer, `must be ${min}-${LIMITS.identifier} characters of [A-Za-z0-9_.:-]`);
      return false;
    }
    return true;
  }
  version(value, pointer) {
    return this.pattern(value, pointer, VERSION, LIMITS.version, 'registry.version.invalid', `must be 1-${LIMITS.version} characters without whitespace`);
  }
  timestamp(value, pointer) {
    if (value === undefined) return false;
    if (typeof value !== 'string' || !TIMESTAMP.test(value) || Number.isNaN(Date.parse(value))) {
      this.add('registry.timestamp.invalid', pointer, 'must be an RFC 3339 date-time with a time zone');
      return false;
    }
    return true;
  }
  oneOf(value, pointer, allowed) {
    if (value === undefined) return false;
    if (typeof value !== 'string' || !allowed.includes(value)) {
      this.add('registry.enum.invalid', pointer, `must be one of: ${allowed.join(', ')}`);
      return false;
    }
    return true;
  }
  integer(value, pointer, min = 0) {
    if (value === undefined) return false;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) {
      this.add('registry.integer.invalid', pointer, `must be an integer >= ${min}`);
      return false;
    }
    return true;
  }
  boolean(value, pointer) {
    if (value !== undefined && typeof value !== 'boolean') this.add('registry.type', pointer, 'must be a boolean');
  }
  url(value, pointer) {
    return this.pattern(value, pointer, HTTPS_URL, LIMITS.locator, 'registry.url.invalid', 'must be an https URL');
  }
  registryId(value, pointer, kinds) {
    if (value === undefined) return false;
    if (!isRegistryId(value, kinds)) {
      this.add('registry.reference.invalid', pointer, `must be a registry id of kind ${kinds.join(' | ')}`);
      return false;
    }
    return true;
  }
}

const COMMON = ['schema', 'kind', 'id', 'provenance'];

/** Members and checks per kind. Everything a document may carry is listed; nothing else is accepted. */
const ENTITIES = {
  product: {
    members: ['productId', 'name', 'summary', 'category', 'homepage', 'status'],
    required: ['productId', 'name'],
    check(c, d) {
      c.pattern(d.productId, '/productId', PRODUCT_ID, 64, 'registry.product.invalid', 'must be a lowercase product id such as feltdb or appport-services');
      c.label(d.name, '/name');
      c.label(d.summary, '/summary', LIMITS.summary);
      c.label(d.category, '/category');
      c.url(d.homepage, '/homepage');
      c.oneOf(d.status, '/status', PRODUCT_STATUSES);
    },
  },
  'product-version': {
    members: ['productId', 'version', 'releasedAt', 'channel', 'packages'],
    required: ['productId', 'version'],
    check(c, d) {
      c.pattern(d.productId, '/productId', PRODUCT_ID, 64, 'registry.product.invalid', 'must be a lowercase product id such as feltdb or appport-services');
      c.version(d.version, '/version');
      c.timestamp(d.releasedAt, '/releasedAt');
      c.oneOf(d.channel, '/channel', RELEASE_CHANNELS);
      if (d.packages !== undefined) {
        if (!Array.isArray(d.packages) || d.packages.length === 0 || d.packages.length > LIMITS.packages) c.add('registry.array.invalid', '/packages', `must be an array of 1-${LIMITS.packages} packages`);
        else d.packages.forEach((p, i) => {
          if (!c.object(p, `/packages/${i}`, ['registry', 'name', 'version'], ['registry', 'name', 'version'])) return;
          c.oneOf(p.registry, `/packages/${i}/registry`, PACKAGE_REGISTRIES);
          c.pattern(p.name, `/packages/${i}/name`, /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/, 214, 'registry.package.invalid', 'must be a package name');
          c.version(p.version, `/packages/${i}/version`);
        });
      }
    },
  },
  repository: {
    members: ['host', 'owner', 'name', 'defaultBranch', 'visibility', 'archived'],
    required: ['host', 'owner', 'name'],
    check(c, d) {
      c.oneOf(d.host, '/host', REPOSITORY_HOSTS);
      c.pattern(d.owner, '/owner', REPOSITORY_SEGMENT, 100, 'registry.repository.invalid', 'must be a repository owner');
      c.pattern(d.name, '/name', REPOSITORY_SEGMENT, 100, 'registry.repository.invalid', 'must be a repository name');
      c.label(d.defaultBranch, '/defaultBranch');
      c.oneOf(d.visibility, '/visibility', REPOSITORY_VISIBILITIES);
      c.boolean(d.archived, '/archived');
    },
  },
  capability: {
    members: ['name', 'version', 'summary'],
    required: ['name'],
    check(c, d) {
      c.pattern(d.name, '/name', CAPABILITY_NAME, LIMITS.identifier, 'registry.capability.invalid', 'must be a namespaced capability name such as invoices.create');
      c.integer(d.version, '/version', 1);
      c.label(d.summary, '/summary', LIMITS.summary);
    },
  },
  integration: {
    members: ['integrationId', 'name', 'integrationKind', 'boundary', 'principal', 'contact'],
    required: ['integrationId', 'name', 'integrationKind', 'boundary'],
    check(c, d) {
      c.pattern(d.integrationId, '/integrationId', SLUG, 64, 'registry.integration.invalid', 'must be a lowercase slug');
      c.label(d.name, '/name');
      c.oneOf(d.integrationKind, '/integrationKind', INTEGRATION_KINDS);
      if (d.boundary !== undefined && c.object(d.boundary, '/boundary', ['mode', 'scopes', 'note'], ['mode', 'scopes'])) {
        c.oneOf(d.boundary.mode, '/boundary/mode', ACCESS_MODES);
        if (d.boundary.scopes !== undefined) {
          if (!Array.isArray(d.boundary.scopes) || d.boundary.scopes.length === 0 || d.boundary.scopes.length > LIMITS.scopes || new Set(d.boundary.scopes).size !== d.boundary.scopes.length) c.add('registry.array.invalid', '/boundary/scopes', `must be an array of 1-${LIMITS.scopes} distinct scopes`);
          else d.boundary.scopes.forEach((s, i) => c.pattern(s, `/boundary/scopes/${i}`, SCOPE, 64, 'registry.scope.invalid', 'must be a scope label such as repository:read'));
        }
        c.label(d.boundary.note, '/boundary/note', LIMITS.summary);
      }
      if (d.principal !== undefined && c.object(d.principal, '/principal', ['type', 'id'], ['type', 'id'])) {
        c.oneOf(d.principal.type, '/principal/type', PRINCIPAL_TYPES);
        c.identifier(d.principal.id, '/principal/id');
      }
      c.label(d.contact, '/contact');
    },
  },
};

const ATTRIBUTE_CHECKS = {
  role: (c, v, p) => c.oneOf(v, p, REPOSITORY_ROLES),
  tag: (c, v, p) => c.version(v, p),
  commit: (c, v, p) => c.pattern(v, p, COMMIT, 64, 'registry.commit.invalid', 'must be a hexadecimal commit id'),
  url: (c, v, p) => c.url(v, p),
  mechanism: (c, v, p) => c.oneOf(v, p, FEEDBACK_INTEGRATION_MECHANISMS),
  mode: (c, v, p) => c.oneOf(v, p, ACCESS_MODES),
  eventType: (c, v, p) => c.pattern(v, p, EVENT_TYPE, 64, 'registry.event-type.invalid', 'must be a dotted event type such as product.released (the vocabulary is boundry.event/1)'),
  occurredAt: (c, v, p) => c.timestamp(v, p),
};

function checkRelationship(c, d) {
  if (!c.oneOf(d.type, '/type', Object.keys(RELATIONSHIP_TYPES))) return;
  const spec = RELATIONSHIP_TYPES[d.type];
  c.registryId(d.from, '/from', spec.from);
  c.registryId(d.to, '/to', spec.to);
  if (d.from !== undefined && d.from === d.to) c.add('registry.relationship.reflexive', '/to', 'must differ from /from');
  if (d.attributes === undefined) {
    if (spec.required?.length) c.add('registry.field.required', '/attributes', `is required for ${d.type}`);
    return;
  }
  if (!c.object(d.attributes, '/attributes', spec.attributes, spec.required ?? [])) return;
  for (const [name, value] of Object.entries(d.attributes)) if (spec.attributes.includes(name)) ATTRIBUTE_CHECKS[name](c, value, `/attributes/${name}`);
}

function checkProvenance(c, p) {
  if (!c.object(p, '/provenance', ['kind', 'source', 'assertedBy', 'observedAt', 'recordedAt'], ['kind', 'source', 'assertedBy', 'observedAt'])) return;
  if (p.recordedAt !== undefined) c.add('registry.provenance.recorded-at.reserved', '/provenance/recordedAt', 'is set by the registry when it records the document');
  const kindOk = c.oneOf(p.kind, '/provenance/kind', PROVENANCE_KINDS);
  if (p.source !== undefined && c.object(p.source, '/provenance/source', ['system', 'locator'], ['system'])) {
    const systemOk = c.oneOf(p.source.system, '/provenance/source/system', SOURCE_SYSTEMS);
    if (p.source.locator !== undefined) c.label(p.source.locator, '/provenance/source/locator', LIMITS.locator);
    if (kindOk && systemOk && p.kind === 'reference') {
      if (!AUTHORITY_SYSTEMS.includes(p.source.system)) c.add('registry.provenance.authority', '/provenance/source/system', `a reference must point at an authority: ${AUTHORITY_SYSTEMS.join(', ')}`);
      if (p.source.locator === undefined) c.add('registry.field.required', '/provenance/source/locator', 'a reference must say where in the authority it points');
    }
  }
  if (p.assertedBy !== undefined && c.object(p.assertedBy, '/provenance/assertedBy', ['type', 'id'], ['type', 'id'])) {
    c.oneOf(p.assertedBy.type, '/provenance/assertedBy/type', ASSERTER_TYPES);
    c.identifier(p.assertedBy.id, '/provenance/assertedBy/id');
  }
  c.timestamp(p.observedAt, '/provenance/observedAt');
}

/**
 * Validates one registry document. Returns `{ ok: true, value, id }` (`value` is the document with its derived `id`
 * filled in) or `{ ok: false, issues }`. `now` bounds how far in the future `observedAt` may be (default 300 s, as
 * `boundry.event/1` bounds `occurredAt`).
 */
export function validateDocument(document, { now = new Date(), maxSkewSeconds = 300 } = {}) {
  const c = new Checker();
  if (!PLAIN(document)) {
    c.add('registry.type', '', 'must be an object');
    return { ok: false, issues: c.issues };
  }
  if (document.schema === undefined) c.add('registry.schema.required', '/schema', 'is required');
  else if (!SUPPORTED_REGISTRY_SCHEMAS.includes(document.schema)) {
    c.add(/^boundry\.registry\/[1-9][0-9]*$/.test(String(document.schema)) ? 'registry.schema.unsupported' : 'registry.schema.invalid', '/schema', `supported: ${SUPPORTED_REGISTRY_SCHEMAS.join(', ')}`);
  }
  if (c.issues.length) return { ok: false, issues: c.issues };
  try {
    if (utf8(canonicalize(document)) > LIMITS.documentBytes) c.add('registry.too-large', '', `must be at most ${LIMITS.documentBytes} bytes of canonical JSON`);
  } catch {
    c.add('registry.json.invalid', '', 'must be JSON with finite numbers');
  }
  if (!c.oneOf(document.kind, '/kind', KINDS)) {
    if (document.kind === undefined) c.add('registry.field.required', '/kind', 'is required');
    return { ok: false, issues: c.issues };
  }
  const spec = document.kind === RELATIONSHIP_KIND
    ? { members: ['type', 'from', 'to', 'attributes'], required: ['type', 'from', 'to'], check: checkRelationship }
    : ENTITIES[document.kind];
  c.object(document, '', [...COMMON, ...spec.members], ['schema', 'kind', 'provenance', ...spec.required]);
  spec.check(c, document);
  if (document.provenance !== undefined) checkProvenance(c, document.provenance);
  if (typeof document.provenance?.observedAt === 'string' && TIMESTAMP.test(document.provenance.observedAt) && Date.parse(document.provenance.observedAt) - now.getTime() > maxSkewSeconds * 1000) {
    c.add('registry.observed-at.future', '/provenance/observedAt', `is more than ${maxSkewSeconds}s in the future`);
  }

  // Credential floor (appport.feedback/1 §5.5): the registry holds identities, never secrets. Never echoes the value.
  for (const [pointer, text] of strings(document)) {
    for (const id of detectSensitive(text)) c.add('registry.sensitive-content', pointer, `appears to contain a credential (${id})`);
  }

  if (c.issues.length) return { ok: false, issues: c.issues };
  const id = registryIdOf(document);
  if (document.id !== undefined && document.id !== id) {
    c.add('registry.id.mismatch', '/id', 'must be the id derived from the document, or absent');
    return { ok: false, issues: c.issues };
  }
  return { ok: true, id, value: { ...document, id } };
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
 * Canonical digest of a document as asserted (RFC 8785 + SHA-256 through `@appport/protocol`, as `boundry.event/1`
 * digests events). `provenance.recordedAt` is excluded: it is the registry's clock, not part of the assertion.
 */
export function documentDigest(document) {
  const { provenance, ...rest } = document;
  const { recordedAt, ...assertion } = provenance ?? {};
  return digestOf({ ...rest, id: registryIdOf(document), provenance: assertion });
}
