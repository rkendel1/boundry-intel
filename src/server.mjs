/**
 * The HTTP boundary: the smallest adapter that lets an authenticated publisher reach the existing deterministic
 * contracts, and nothing more.
 *
 * **It owns no decisions.** Validation belongs to `validateEvent`, authority to `PublisherDirectory.authenticate`
 * and `authorizes`, identity and idempotency to `EventAcceptor`. This module parses a request, hands the envelopes
 * to the acceptor, and turns the acceptor's own answers into a response. There is deliberately no second copy of the
 * schema, the scope check or the digest rule here: a duplicate would be a place for the two to disagree, and the HTTP
 * surface is the half that would be wrong.
 *
 * **It never acknowledges what was not stored.** The acceptor commits before it answers `accepted`, and throws when
 * storage fails. A throw becomes `503` with `retryable: true` and no per-envelope answers, so a publisher resends the
 * same batch — safe because identity is `(product.id, id)` and a resend of a stored event answers `duplicate`.
 *
 * **Nothing is queued.** There is no buffer, no background flush and no retry timer in this process: a request is
 * either committed before the response or reported as not accepted. An in-memory queue here would be a place for
 * accepted events to disappear, and a background retry would be a place for a publisher to be told `accepted` before
 * anything durable happened.
 *
 * Routes:
 *
 * | Method | Path                            | Who          |
 * |--------|---------------------------------|--------------|
 * | GET    | `/health`                       | anyone       |
 * | GET    | `/ready`                        | anyone       |
 * | POST   | `/v1/events`                    | publisher    |
 * | GET    | `/v1/events/:productId/:eventId`| publisher    |
 * | POST   | `/v1/publishers`                | operator     |
 * | POST   | `/v1/publishers/:id/revoke`     | operator     |
 * | GET    | `/v1/publishers`                | operator     |
 * | GET    | `/.well-known/appport`          | reader       |
 * | GET    | `/appport/manifest`             | reader       |
 * | POST   | `/appport`                      | reader       |
 * | POST   | `/mcp`                          | reader       |
 *
 * "reader" is the operator token or the read-only reader token (`capabilities.mjs`). The last four routes are the
 * inspection surface: AppPort's own HTTP binding and the MCP projection of the same application, mounted only when an
 * inspection application is given. They are read-only because every capability in that application is.
 * The operator routes are mounted only when an operator token is configured. `src/publishers.mjs` deliberately leaves
 * operator authentication to its caller; this module is that caller, and it refuses the routes rather than exposing
 * `issue` and `revoke` to anyone who can reach the port.
 */
import { createServer as createHttpServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';

import { AppPortServer, createHttpBinding } from '@appport/server';
import { createMcpHandler } from '@appport/mcp';
import { AppPortError } from '@appport/protocol';

import { MAX_BATCH } from './acceptance.mjs';
import { PUBLISHER_SCOPES, PUBLISHER_SUBJECT_KINDS } from './publishers.mjs';
import { describeConfig } from './config.mjs';
import { readerIdentity } from './capabilities.mjs';

/** Compares two tokens without leaking their length difference through timing. */
function sameToken(presented, expected) {
  if (typeof presented !== 'string' || typeof expected !== 'string') return false;
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

const bearer = (request) => {
  const header = request.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match ? match[1] : null;
};

/** The HTTP status one envelope's answer deserves, for a single-envelope request. */
const STATUS_OF = Object.freeze({ accepted: 200, duplicate: 200, conflict: 409, rejected: 400, unauthorized: 403 });

class RequestError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

/** Reads a JSON body under a byte cap, refusing anything larger without buffering the rest. */
async function readJson(request, maxBodyBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBodyBytes) {
      // Stop reading, but do not destroy the socket here: the response must reach the publisher, so it learns the
      // body was too large instead of seeing a connection reset it cannot tell from an outage. The socket is closed
      // after the response is flushed.
      request.pause();
      throw new RequestError(413, 'REQUEST_TOO_LARGE', `the request body is larger than ${maxBodyBytes} bytes`);
    }
    chunks.push(chunk);
  }
  if (size === 0) throw new RequestError(400, 'BODY_REQUIRED', 'a JSON body is required');
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) {
    throw new RequestError(400, 'BODY_INVALID', `the body is not JSON: ${error.message}`);
  }
}

/**
 * Builds the request handler.
 *
 * @param {{
 *   config: ReturnType<import('./config.mjs').resolveRuntimeConfig>,
 *   publishers: import('./publishers.mjs').PublisherDirectory,
 *   events: import('./acceptance.mjs').EventAcceptor,
 *   readiness: () => Promise<{ ready: boolean, detail?: string }>,
 *   application?: import('@appport/core').AppPortApplication,
 *   monitor?: import('./inspection.mjs').IngestionMonitor,
 *   log?: (entry: object) => void,
 *   now?: () => Date,
 * }} parts
 */
export function createIntelHandler({ config, publishers, events, readiness, application, monitor, log = defaultLog, now = () => new Date() }) {
  const operatorEnabled = Boolean(config.operatorToken);
  const credentials = { operatorToken: config.operatorToken, readerToken: config.readerToken ?? null, now };

  // The inspection surface. Authentication happens twice on purpose: once here, before anything is read (so an
  // unauthenticated caller gets nothing, not even the manifest), and once inside AppPort, which authorizes every
  // capability against the identity it is handed regardless of transport.
  const identify = (headers) => {
    const result = readerIdentity(headers, credentials);
    return result.ok ? result.identity : undefined;
  };
  const appport = application
    ? createHttpBinding({ server: new AppPortServer({ application, authenticate: (request) => identify(request.headers ?? {}) }), statusMode: 'mapped', maxBodyBytes: config.maxBodyBytes })
    : null;
  const mcp = application
    ? createMcpHandler(application, {
        serverInfo: { name: 'boundry-intel', version: application.manifest().application.version },
        context: ({ headers }) => {
          const flat = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v[0] : v]));
          const identity = identify(flat);
          if (!identity) throw new AppPortError('UNAUTHORIZED', 'a reader or operator token and a Boundry-Operator name are required');
          return identity;
        },
      })
    : null;
  const reader = (request) => {
    if (!application) throw new RequestError(404, 'NOT_FOUND', 'no such route');
    const result = readerIdentity(request.headers, credentials);
    if (!result.ok) throw new RequestError(result.status, result.code, result.message);
    return result;
  };
  const readText = async (request) => {
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > config.maxBodyBytes) {
        request.pause();
        throw new RequestError(413, 'REQUEST_TOO_LARGE', `the request body is larger than ${config.maxBodyBytes} bytes`);
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
  };
  const headerRecord = (request) => Object.fromEntries(Object.entries(request.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : v]));
  /** Hands a request to AppPort's own HTTP binding and returns its outcome unchanged. */
  const viaAppPort = async (request, path) => {
    reader(request);
    const body = request.method === 'POST' ? await readText(request) : undefined;
    const outcome = await appport.route({ method: request.method, path, query: new URL(request.url, 'http://localhost').searchParams, headers: headerRecord(request), body });
    if (outcome.kind === 'stream') {
      // No capability here streams; a stream outcome is drained so the response is still well-formed.
      let text = '';
      for await (const frame of outcome.frames) text += frame;
      return { status: outcome.status, raw: { headers: outcome.headers, text } };
    }
    return { status: outcome.status, raw: { headers: outcome.headers, text: outcome.kind === 'json' ? `${JSON.stringify(outcome.body)}\n` : outcome.body } };
  };

  /** Authenticates the operator, or throws. Never says which half of the check failed. */
  const operator = (request) => {
    if (!operatorEnabled) throw new RequestError(404, 'NOT_FOUND', 'no operator boundary is configured on this service');
    const presented = bearer(request);
    if (!presented || !sameToken(presented, config.operatorToken)) throw new RequestError(401, 'OPERATOR_UNAUTHENTICATED', 'an operator token is required');
    // Attributable: an operator act names who the caller says they are, and the service records that name on the key.
    const who = request.headers['boundry-operator'];
    const name = typeof who === 'string' && who.trim() !== '' ? who.trim() : null;
    if (!name) throw new RequestError(400, 'OPERATOR_UNNAMED', 'the Boundry-Operator header must name the operator, so the act is attributable');
    if (!/^[^\u0000-\u001f\u007f]{1,200}$/.test(name)) throw new RequestError(400, 'OPERATOR_UNNAMED', 'Boundry-Operator must be a single-line name of at most 200 characters');
    return name;
  };

  const routes = [
    // ── Liveness and readiness ───────────────────────────────────────────────
    {
      method: 'GET',
      path: /^\/health$/,
      // Liveness only: that this process is running and can answer. It says nothing about storage on purpose, so a
      // platform's restart policy does not kill a process that is merely waiting for its authority to come back.
      handle: async () => ({ status: 200, body: { status: 'alive', at: now().toISOString() } }),
    },
    {
      method: 'GET',
      path: /^\/ready$/,
      // Readiness means the configured durable storage is usable right now. A process whose authority is unreachable
      // reports 503 and takes no traffic, because accepting an event it cannot store would be the one unforgivable
      // answer.
      handle: async () => {
        const probe = await readiness();
        return {
          status: probe.ready ? 200 : 503,
          body: { status: probe.ready ? 'ready' : 'unready', storage: describeConfig(config).storage, ...(probe.detail ? { detail: probe.detail } : {}), at: now().toISOString() },
        };
      },
    },

    // ── Event ingestion ─────────────────────────────────────────────────────
    {
      method: 'POST',
      path: /^\/v1\/events$/,
      handle: async (request) => {
        const key = bearer(request);
        if (!key) {
          monitor?.request('unauthenticated', { code: 'PUBLISHER_UNAUTHENTICATED' });
          throw new RequestError(401, 'PUBLISHER_UNAUTHENTICATED', 'a publisher key is required');
        }
        let body;
        try {
          body = await readJson(request, config.maxBodyBytes);
        } catch (error) {
          monitor?.request('invalidRequest', { code: error.code });
          throw error;
        }
        // One envelope or a batch. Both go through the same acceptor call, so a batch of one is not a special case.
        const envelopes = Array.isArray(body) ? body : Array.isArray(body?.events) ? body.events : [body];
        if (envelopes.length === 0) throw new RequestError(400, 'BATCH_EMPTY', 'send at least one event');
        if (envelopes.length > MAX_BATCH) throw new RequestError(413, 'BATCH_TOO_LARGE', `a batch carries at most ${MAX_BATCH} envelopes`);

        let answers;
        try {
          answers = await events.accept(key, envelopes);
        } catch (error) {
          if (!(error instanceof TypeError)) monitor?.request('unavailable', { code: error?.code ?? error?.name, message: error?.message });
          throw error;
        }
        monitor?.answers(answers);
        // The acceptor answers per envelope and never throws for a refusal, so every answer here is a decision it
        // made. A thrown storage failure is caught further out and becomes 503.
        const single = !Array.isArray(body) && !Array.isArray(body?.events);
        const status = single ? (STATUS_OF[answers[0].status] ?? 200) : 200;
        return { status, body: single ? answers[0] : { answers } };
      },
    },
    {
      method: 'GET',
      path: /^\/v1\/events\/([^/]+)\/([^/]+)$/,
      handle: async (request, [productId, eventId]) => {
        const key = bearer(request);
        if (!key) throw new RequestError(401, 'PUBLISHER_UNAUTHENTICATED', 'a publisher key is required');
        const publisher = await publishers.authenticate(key);
        // Reading is bounded by the same subject binding as writing: a publisher reads its own product's events.
        if (!publisher || publisher.productId !== decodeURIComponent(productId)) throw new RequestError(403, 'EVENT_PRODUCT_FORBIDDEN', 'a publisher may only read events for its own product');
        await publishers.touch(publisher.publisherId);
        const stored = await events.get(decodeURIComponent(productId), decodeURIComponent(eventId));
        if (!stored) throw new RequestError(404, 'NOT_FOUND', 'no such event');
        return { status: 200, body: stored };
      },
    },

    // ── Operator ────────────────────────────────────────────────────────────
    {
      method: 'POST',
      path: /^\/v1\/publishers$/,
      handle: async (request) => {
        const createdBy = operator(request);
        const body = await readJson(request, config.maxBodyBytes);
        const { subject, name, scopes } = body ?? {};
        if (!Array.isArray(scopes)) throw new RequestError(400, 'SCOPES_REQUIRED', `scopes must be a non-empty set of: ${PUBLISHER_SCOPES.join(', ')}`);
        let issued;
        try {
          // The directory owns every rule about subjects, names and scopes; a bad request is its refusal, not ours.
          issued = await publishers.issue({ subject, name, scopes, createdBy });
        } catch (error) {
          throw new RequestError(400, 'PUBLISHER_INVALID', error.message);
        }
        log({ event: 'publisher.issued', publisherId: issued.publisher.publisherId, subject: issued.publisher.subject, scopes: issued.publisher.scopes, createdBy, at: now().toISOString() });
        // The key crosses the wire exactly once, here, and is never logged: the log line above names the id only.
        return { status: 201, body: { publisher: issued.publisher, key: issued.key } };
      },
    },
    {
      method: 'POST',
      path: /^\/v1\/publishers\/([^/]+)\/revoke$/,
      handle: async (request, [publisherId]) => {
        const revokedBy = operator(request);
        const id = decodeURIComponent(publisherId);
        const revoked = await publishers.revoke(id, { revokedBy });
        if (!revoked) throw new RequestError(404, 'NOT_FOUND', 'no such publisher');
        log({ event: 'publisher.revoked', publisherId: id, revokedBy, at: now().toISOString() });
        return { status: 200, body: { publisherId: id, revoked: true } };
      },
    },
    {
      method: 'GET',
      path: /^\/v1\/publishers$/,
      handle: async (request) => {
        operator(request);
        const url = new URL(request.url, 'http://localhost');
        const filter = {
          ...(url.searchParams.has('subject') ? { subject: url.searchParams.get('subject') } : {}),
          ...(url.searchParams.has('productId') ? { productId: url.searchParams.get('productId') } : {}),
        };
        // `view()` in the directory already keeps the hash and the key out of what it returns.
        return { status: 200, body: { publishers: await publishers.list(filter), subjectKinds: PUBLISHER_SUBJECT_KINDS, scopes: PUBLISHER_SCOPES } };
      },
    },

    // ── Inspection (read-only): AppPort discovery, manifest and requests; MCP over the same application ─────────
    { method: 'GET', path: /^\/\.well-known\/appport$/, handle: (request, _params, path) => viaAppPort(request, path) },
    { method: 'GET', path: /^\/appport\/manifest$/, handle: (request, _params, path) => viaAppPort(request, path) },
    { method: 'POST', path: /^\/appport$/, handle: (request, _params, path) => viaAppPort(request, path) },
    {
      method: 'POST',
      path: /^\/mcp$/,
      handle: async (request) => {
        reader(request);
        const body = await readText(request);
        const headers = new Headers();
        for (const [name, value] of Object.entries(headerRecord(request))) if (value !== undefined) headers.set(name, value);
        const answer = await mcp(new Request(new URL(request.url, 'http://localhost'), { method: 'POST', headers, body }));
        return { status: answer.status, raw: { headers: Object.fromEntries(answer.headers.entries()), text: await answer.text() } };
      },
    },
  ];

  return async function handler(request, response) {
    const started = Date.now();
    const path = (request.url ?? '/').split('?')[0];
    let outcome;
    try {
      const route = routes.find((r) => r.method === request.method && r.path.test(path));
      if (!route) {
        const pathExists = routes.some((r) => r.path.test(path));
        throw new RequestError(pathExists ? 405 : 404, pathExists ? 'METHOD_NOT_ALLOWED' : 'NOT_FOUND', pathExists ? `${request.method} is not allowed here` : 'no such route');
      }
      const params = route.path.exec(path).slice(1);
      outcome = await route.handle(request, params, path);
    } catch (error) {
      outcome = failure(error, log, now);
    }
    const payload = Buffer.from(outcome.raw ? outcome.raw.text : `${JSON.stringify(outcome.body)}\n`, 'utf8');
    const abandoned = !request.readableEnded;
    // A delegated outcome (AppPort, MCP) keeps its own content type; length, caching and connection are always ours.
    const passed = outcome.raw ? Object.fromEntries(Object.entries(outcome.raw.headers).filter(([k]) => !['content-length', 'connection', 'transfer-encoding', 'cache-control'].includes(k.toLowerCase()))) : {};
    response.writeHead(outcome.status, { 'content-type': 'application/json; charset=utf-8', ...passed, 'content-length': String(payload.length), 'cache-control': 'no-store', ...(abandoned ? { connection: 'close' } : {}) });
    response.end(payload, () => {
      // A request whose body was refused part-way is not drained: the rest is dropped with the socket, after the
      // publisher has its answer.
      if (abandoned) request.destroy();
    });
    // One structured line per request. No body, no key, no operator token, no event content: a path, a status and a
    // duration are enough to operate the service and carry nothing a log should not hold.
    if (path !== '/health' && path !== '/ready') log({ event: 'request', method: request.method, path, status: outcome.status, ms: Date.now() - started });
  };
}

/**
 * Turns a thrown error into a response.
 *
 * A storage failure is the one that matters: the acceptor throws rather than answering, and this must become a
 * retryable `503`. Anything unrecognized is also a `503` rather than a `500` with a stack, because an unknown failure
 * on the write path is indistinguishable from an unavailable authority from the publisher's side, and telling it to
 * retry is the safe answer when identity makes a resend free.
 */
function failure(error, log, now) {
  if (error instanceof RequestError) {
    return { status: error.status, body: { status: 'error', code: error.code, message: error.message, ...error.extra } };
  }
  if (error instanceof TypeError) {
    return { status: 400, body: { status: 'error', code: 'REQUEST_INVALID', message: error.message } };
  }
  log({ event: 'storage.unavailable', code: error?.code ?? error?.name ?? 'UNKNOWN', message: String(error?.message ?? error).slice(0, 500), at: now().toISOString() });
  return {
    status: 503,
    body: {
      status: 'unavailable',
      code: 'STORAGE_UNAVAILABLE',
      retryable: true,
      message: 'the event could not be stored; nothing was accepted. Resend the same batch: identity is (product.id, id), so a resend of a stored event answers duplicate.',
    },
  };
}

const defaultLog = (entry) => {
  process.stdout.write(`${JSON.stringify(entry)}\n`);
};

/**
 * Starts the service: resolves the configuration, opens the database, checks readiness once, and listens.
 *
 * The order matters. The configuration is resolved before anything is opened, so a production process with no durable
 * storage configured exits with a configuration error instead of binding a port and accepting events it cannot keep.
 *
 * @param {{ db: import('@feltdb/core').StateFirstDB, config: object, publishers: object, events: object, readiness: () => Promise<{ready: boolean, detail?: string}>, log?: (e: object) => void }} parts
 */
export function startIntelServer(parts) {
  const { config, log = defaultLog } = parts;
  const server = createHttpServer(createIntelHandler(parts));
  server.requestTimeout = config.requestTimeoutMs;
  server.headersTimeout = Math.max(5_000, Math.floor(config.requestTimeoutMs / 2));

  const close = async () => {
    await new Promise((resolve) => server.close(resolve));
    log({ event: 'shutdown.complete', at: new Date().toISOString() });
  };
  // Graceful shutdown: stop accepting connections, let in-flight requests finish, then let the caller close storage.
  // An in-flight accept is a committed-or-not decision already in the acceptor's hands; nothing is buffered to lose.
  const onSignal = (signal) => {
    log({ event: 'shutdown.started', signal, at: new Date().toISOString() });
    void close().then(() => parts.onShutdown?.());
  };
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => onSignal(signal));

  return new Promise((resolve) => {
    server.listen(config.port, process.env.BOUNDRY_INTEL_HOST || '0.0.0.0', () => {
      log({ event: 'listening', port: server.address().port, ...describeConfig(config), at: new Date().toISOString() });
      resolve({ server, port: server.address().port, close });
    });
  });
}
