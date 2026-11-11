#!/usr/bin/env node
/**
 * `intel`: the operator's command line over Boundry Intel's read capabilities.
 *
 * It is a client of the deployed service's AppPort endpoint and nothing else: every command is one `intel.*`
 * capability request (export is that same request, paged), so the CLI, an agent over MCP and any AppPort client see
 * the same contract, the same limits and the same authorization. It never touches a database.
 *
 *   BOUNDRY_INTEL_URL       service base URL (default https://intel.trythissoftware.com)
 *   BOUNDRY_INTEL_TOKEN     reader token (or the operator token)
 *   BOUNDRY_INTEL_AS        your name, sent as Boundry-Operator so the read is attributable
 *
 * Output is JSON on stdout. Exit status: 0 success, 1 the service refused or failed, 2 usage.
 */
import { writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

import { createRequest } from '@appport/protocol';

const USAGE = `usage: intel <command> [options]

  health                               liveness and storage readiness (no token needed)
  status [--stale-after S]             health, counts, freshness, publisher activity, refusals since start
  datasets                             every dataset: meaning, fields, counts, time range, retention, sensitivity
  events [filters] [--oldest] [--limit N] [--cursor C]
                                       accepted events, newest first
         filters: --product ID --type T --correlation ID --publisher ID --after RFC3339 --before RFC3339
  event <productId> <eventId>          one event with provenance and an integrity check
  registry [--kind K] [--product ID] [--limit N] [--cursor C]
  record <registryId>                  one registry record, its history and relationships
  publishers [--product ID] [--stale-after S]
  diagnose [--stale-after S]           why data may be missing or stale
  capabilities                         the AppPort manifest (what agents see)
  export events|registry [filters] [--max N] [--out FILE]
                                       every matching record, paged, as one JSON document

  env: BOUNDRY_INTEL_URL, BOUNDRY_INTEL_TOKEN, BOUNDRY_INTEL_AS`;

const FLAGS = { product: 'productId', type: 'type', correlation: 'correlationId', publisher: 'publisherId', after: 'receivedAfter', before: 'receivedBefore', kind: 'kind', cursor: 'cursor' };
const NUMERIC = { limit: 'limit', 'stale-after': 'staleAfterSeconds', max: 'max' };

class UsageError extends Error {}

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  const positional = [];
  const input = {};
  let out;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const name = arg.slice(2);
    if (name === 'oldest') {
      input.order = 'oldest';
      continue;
    }
    const value = rest[++i];
    if (value === undefined) throw new UsageError(`--${name} needs a value`);
    if (name === 'out') out = value;
    else if (FLAGS[name]) input[FLAGS[name]] = value;
    else if (NUMERIC[name]) {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1) throw new UsageError(`--${name} must be a positive integer`);
      input[NUMERIC[name]] = n;
    } else throw new UsageError(`unknown option --${name}`);
  }
  return { command, positional, input, out };
}

export function client({ url, token, as, fetchImpl = fetch }) {
  const base = url.replace(/\/+$/, '');
  const headers = { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(as ? { 'boundry-operator': as } : {}) };
  const get = async (path, auth = true) => {
    const response = await fetchImpl(`${base}${path}`, { headers: auth ? headers : {} });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  const call = async (name, input = {}) => {
    const request = createRequest({ requestId: `req_${randomUUID()}`, capability: { name, version: 1 }, input });
    const response = await fetchImpl(`${base}/appport`, { method: 'POST', headers, body: JSON.stringify(request) });
    const body = await response.json().catch(() => null);
    if (body?.type === 'response' && body.ok) return body.output;
    const error = body?.error ?? body ?? { message: `HTTP ${response.status}` };
    throw Object.assign(new Error(`${error.code ?? response.status}: ${error.message}`), { status: response.status, detail: error });
  };
  return { get, call };
}

/** Pages a list capability to the end (or `max`), keeping order, ids, timestamps and provenance as returned. */
export async function exportAll(api, { what, input, max = 10_000, now = () => new Date() }) {
  const capability = what === 'events' ? 'intel.events.list' : what === 'registry' ? 'intel.registry.list' : null;
  if (!capability) throw new UsageError('export needs events or registry');
  const field = what === 'events' ? 'events' : 'records';
  const { cursor: _ignored, max: _max, ...filter } = input;
  // FeltDB binds a cursor to the exact query, page size included, so the page size never changes mid-export. The
  // export stops at the last whole page that fits in `max` and says where to resume.
  const size = Math.min(200, max);
  const records = [];
  let cursor;
  let pages = 0;
  for (;;) {
    const page = await api.call(capability, { ...filter, limit: size, ...(cursor ? { cursor } : {}) });
    records.push(...page[field]);
    pages += 1;
    cursor = page.nextCursor;
    if (!cursor || records.length + size > max) break;
  }
  return { exportedAt: now().toISOString(), capability, filter, pages, count: records.length, complete: !cursor, ...(cursor ? { resumeCursor: cursor } : {}), [field]: records };
}

export async function run(argv, env = process.env, io = { out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s) }) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    io.err(`${error.message}\n${USAGE}\n`);
    return 2;
  }
  const { command, positional, input, out } = parsed;
  if (!command || command === 'help' || command === '--help') {
    io.out(`${USAGE}\n`);
    return command ? 0 : 2;
  }
  const api = client({ url: env.BOUNDRY_INTEL_URL || 'https://intel.trythissoftware.com', token: env.BOUNDRY_INTEL_TOKEN, as: env.BOUNDRY_INTEL_AS });
  const print = (value) => io.out(`${JSON.stringify(value, null, 2)}\n`);
  const needsAuth = command !== 'health';
  if (needsAuth && (!env.BOUNDRY_INTEL_TOKEN || !env.BOUNDRY_INTEL_AS)) {
    io.err('BOUNDRY_INTEL_TOKEN and BOUNDRY_INTEL_AS must be set (a reader or operator token, and your name)\n');
    return 2;
  }
  try {
    switch (command) {
      case 'health': {
        const [health, ready] = await Promise.all([api.get('/health', false), api.get('/ready', false)]);
        print({ health: health.body, ready: ready.body });
        return health.status === 200 && ready.status === 200 ? 0 : 1;
      }
      case 'status':
        print(await api.call('intel.status', input));
        return 0;
      case 'datasets':
        print(await api.call('intel.datasets.list', {}));
        return 0;
      case 'events':
        print(await api.call('intel.events.list', input));
        return 0;
      case 'event':
        if (positional.length !== 2) throw new UsageError('event needs <productId> <eventId>');
        print(await api.call('intel.events.get', { productId: positional[0], eventId: positional[1] }));
        return 0;
      case 'registry':
        print(await api.call('intel.registry.list', input));
        return 0;
      case 'record':
        if (positional.length !== 1) throw new UsageError('record needs <registryId>');
        print(await api.call('intel.registry.get', { id: positional[0] }));
        return 0;
      case 'publishers':
        print(await api.call('intel.publishers.list', input));
        return 0;
      case 'diagnose':
        print(await api.call('intel.diagnostics', input));
        return 0;
      case 'capabilities': {
        const manifest = await api.get('/appport/manifest');
        if (manifest.status !== 200) throw new Error(`${manifest.body?.code ?? manifest.status}: ${manifest.body?.message ?? 'manifest refused'}`);
        print(manifest.body);
        return 0;
      }
      case 'export': {
        const { max, ...filter } = input;
        const document = await exportAll(api, { what: positional[0], input: filter, max: max ?? 10_000 });
        if (out) {
          writeFileSync(out, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
          io.err(`wrote ${document.count} record(s) to ${out}${document.complete ? '' : ' (stopped at --max; resumeCursor is in the file)'}\n`);
        } else print(document);
        return 0;
      }
      default:
        throw new UsageError(`unknown command ${command}`);
    }
  } catch (error) {
    if (error instanceof UsageError) {
      io.err(`${error.message}\n${USAGE}\n`);
      return 2;
    }
    io.err(`${error.message}\n`);
    return 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await run(process.argv.slice(2));
}
