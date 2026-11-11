/**
 * What the service needs before it will start, and why it refuses to start without it.
 *
 * **The hazard this exists to close.** `@feltdb/core` resolves an absent configuration to `local` mode and a path
 * under the working directory: `resolveFeltDBDeployment({}, …)` answers
 * `{ mode: 'local', namespace: 'default', path: '<cwd>/.feltdb/default', source: 'auto' }`. A service deployed with a
 * missing or misspelled variable would therefore come up happily, accept events, answer `accepted`, and write them to
 * a container filesystem that disappears on the next deploy. Every publisher would have been told its event was
 * durable. So in production this module refuses `local` and `memory` outright: a service that cannot prove durable
 * storage must not start, rather than start and lie.
 *
 * **What production means here.** `BOUNDRY_INTEL_ENV=production`, or `NODE_ENV=production` when the former is unset.
 * Anything else is a development configuration, where `local` is allowed and is the normal way to run the tests.
 *
 * Nothing here contacts the network: resolving the configuration is pure over the environment, so a misconfiguration
 * is found before a socket is opened and can be reported as a configuration error rather than an outage.
 */
import { resolveFeltDBDeployment } from '@feltdb/core';

/** Modes that keep data only for as long as the process or its container lives. */
export const EPHEMERAL_MODES = Object.freeze(['local', 'memory', 'browser']);

/** The one FeltDB mode that is a managed authority: state outlives this process. */
export const DURABLE_MODE = 'remote';

export class ConfigurationError extends Error {
  constructor(message, { problems = [] } = {}) {
    super(message);
    this.name = 'ConfigurationError';
    this.code = 'CONFIGURATION_INVALID';
    this.problems = Object.freeze([...problems]);
  }
}

const trimmed = (value) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined);

/**
 * The service's configuration, from the environment alone.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {{
 *   production: boolean,
 *   storage: { mode: string, url?: string, namespace: string, applicationId?: string, environment?: string, path?: string, durable: boolean, source: string },
 *   port: number,
 *   operatorToken: string | null,
 *   readerToken: string | null,
 *   maxBodyBytes: number,
 *   requestTimeoutMs: number,
 * }}
 */
export function resolveRuntimeConfig(env = process.env) {
  const production = (trimmed(env.BOUNDRY_INTEL_ENV) ?? trimmed(env.NODE_ENV)) === 'production';
  const problems = [];

  let resolution;
  try {
    resolution = resolveFeltDBDeployment(undefined, { env, isNode: true, isBrowser: false, configFile: null });
  } catch (error) {
    // A half-given remote configuration (a mode with no url, for one) throws here. In production that is fatal; in
    // development it would silently become `local`, which is exactly the confusion this module refuses to allow.
    throw new ConfigurationError(`FeltDB configuration is invalid: ${error.message}`, { problems: [String(error.message)] });
  }

  // Embedded storage: a FeltDB inside this process, durable only because its directory is a persistent volume. It is an
  // explicit opt-in and still never a default; whether the path really is a mounted volume is checked at startup
  // (`assertPersistentMount`), because the configuration alone cannot know.
  const embedded = trimmed(env.BOUNDRY_INTEL_STORAGE) === 'embedded';
  const embeddedPath = trimmed(resolution.path);
  if (embedded && resolution.mode !== 'local') problems.push(`BOUNDRY_INTEL_STORAGE=embedded needs FELTDB_MODE=local, got "${resolution.mode}".`);
  if (embedded && resolution.mode === 'local' && !(embeddedPath && embeddedPath.startsWith('/'))) problems.push('BOUNDRY_INTEL_STORAGE=embedded needs FELTDB_PATH set to an absolute path on a persistent volume.');
  const embeddedOk = embedded && resolution.mode === 'local' && Boolean(embeddedPath?.startsWith('/'));
  const durable = resolution.mode === DURABLE_MODE || embeddedOk;
  if (production && !durable) {
    problems.push(
      `FeltDB mode is "${resolution.mode}" (resolved from ${resolution.source}), which does not outlive this process. ` +
        `Production requires mode "${DURABLE_MODE}": set FELTDB_URL and FELTDB_TOKEN (and FELTDB_APPLICATION_ID, FELTDB_NAMESPACE, FELTDB_ENVIRONMENT for a managed authority), or BOUNDRY_INTEL_STORAGE=embedded with FELTDB_MODE=local and FELTDB_PATH on a persistent volume.`,
    );
  }
  if (production && durable && !embeddedOk && !trimmed(resolution.token)) {
    problems.push('FELTDB_TOKEN is required in production: a managed authority refuses every data call without a service key.');
  }

  const operatorToken = trimmed(env.BOUNDRY_INTEL_OPERATOR_TOKEN) ?? null;
  // Issuing and revoking publisher keys is an operator act. Without a token the operator routes are not mounted at
  // all, which is safe anywhere; in production, running the service with no way to revoke a key is not.
  if (production && !operatorToken) {
    problems.push('BOUNDRY_INTEL_OPERATOR_TOKEN is required in production: publisher issuance and revocation must have an authenticated operator boundary.');
  }
  if (operatorToken && operatorToken.length < 32) {
    problems.push('BOUNDRY_INTEL_OPERATOR_TOKEN must be at least 32 characters.');
  }

  // A read-only credential for the inspection surface (AppPort and MCP), so an agent or a dashboard can read what the
  // service holds without holding the token that issues and revokes publisher keys. Optional: the operator token reads
  // too. It must not equal the operator token, or "read-only" would be a label rather than a boundary.
  const readerToken = trimmed(env.BOUNDRY_INTEL_READER_TOKEN) ?? null;
  if (readerToken && readerToken.length < 32) problems.push('BOUNDRY_INTEL_READER_TOKEN must be at least 32 characters.');
  if (readerToken && operatorToken && readerToken === operatorToken) problems.push('BOUNDRY_INTEL_READER_TOKEN must differ from BOUNDRY_INTEL_OPERATOR_TOKEN.');

  // 0 is allowed and means "let the operating system choose", which is how the tests bind without fighting over ports.
  const port = Number(trimmed(env.PORT) ?? '8080');
  if (!Number.isInteger(port) || port < 0 || port > 65_535) problems.push(`PORT must be a port number or 0, got ${JSON.stringify(env.PORT)}.`);

  const maxBodyBytes = Number(trimmed(env.BOUNDRY_INTEL_MAX_BODY_BYTES) ?? '1048576');
  if (!Number.isInteger(maxBodyBytes) || maxBodyBytes < 1024) problems.push('BOUNDRY_INTEL_MAX_BODY_BYTES must be an integer of at least 1024.');

  const requestTimeoutMs = Number(trimmed(env.BOUNDRY_INTEL_REQUEST_TIMEOUT_MS) ?? '30000');
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1000) problems.push('BOUNDRY_INTEL_REQUEST_TIMEOUT_MS must be an integer of at least 1000.');

  if (problems.length) throw new ConfigurationError(`the service cannot start: ${problems.length} configuration problem(s)`, { problems });

  return Object.freeze({
    production,
    storage: Object.freeze({
      mode: resolution.mode,
      url: resolution.url,
      namespace: resolution.namespace,
      applicationId: resolution.applicationId,
      environment: resolution.environment,
      path: resolution.path,
      durable,
      embedded: embeddedOk,
      source: resolution.source,
    }),
    port,
    operatorToken,
    readerToken,
    maxBodyBytes,
    requestTimeoutMs,
  });
}

/**
 * The configuration as it is safe to log or serve: the storage identity without the token, and whether an operator
 * boundary exists without saying what authenticates it.
 */
export const describeConfig = (config) => ({
  production: config.production,
  storage: { mode: config.storage.mode, url: config.storage.url ?? null, namespace: config.storage.namespace, applicationId: config.storage.applicationId ?? null, environment: config.storage.environment ?? null, durable: config.storage.durable, embedded: Boolean(config.storage.embedded), path: config.storage.embedded ? config.storage.path : null, source: config.storage.source },
  operatorBoundary: config.operatorToken ? 'configured' : 'absent',
  readBoundary: config.readerToken ? 'operator and reader tokens' : config.operatorToken ? 'operator token only' : 'absent',
  limits: { maxBodyBytes: config.maxBodyBytes, requestTimeoutMs: config.requestTimeoutMs },
});

/**
 * Refuses an embedded store whose directory is not on a mounted volume.
 *
 * `mountinfo` is the text of `/proc/self/mountinfo`. The longest mount point that contains `path` must not be `/`: the
 * container's root filesystem is rebuilt on every deploy, so a path that resolves to it would accept events and lose
 * them. This is the embedded equivalent of refusing `local` in production.
 */
export function assertPersistentMount(path, mountinfo) {
  const mounts = String(mountinfo)
    .split('\n')
    .map((line) => line.split(' ')[4])
    .filter(Boolean)
    .map((mount) => mount.replace(/\\040/g, ' '));
  const holder = mounts
    .filter((mount) => path === mount || path.startsWith(mount.endsWith('/') ? mount : `${mount}/`))
    .sort((a, b) => b.length - a.length)[0];
  if (!holder || holder === '/') {
    throw new ConfigurationError('the embedded store is not on a persistent volume', {
      problems: [`FELTDB_PATH ${path} is on the container root filesystem, which does not outlive a deploy. Mount a volume and put FELTDB_PATH under it.`],
    });
  }
  return holder;
}
