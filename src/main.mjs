/**
 * The deployable entry point: `node src/main.mjs`.
 *
 * It does four things in this order, and the order is the whole point.
 *
 * 1. Resolve the configuration. A production process with no durable storage configured exits here, before a port is
 *    bound, with the problems named. It never reaches a state where it could accept an event it cannot keep.
 * 2. Open the FeltDB the configuration names.
 * 3. Check that the store is usable, and say so in the log. On a managed authority this is where an unpublished or
 *    unpromoted contract shows up, because the authority refuses data calls until its contract is active.
 * 4. Listen.
 *
 * Readiness is re-checked on every `/ready` request rather than cached, so a process whose authority goes away stops
 * reporting itself ready without needing to be restarted.
 */
import { readFileSync } from 'node:fs';

import { createFeltDB } from '@feltdb/core';

import { prepare } from './application.mjs';

import { EventAcceptor } from './acceptance.mjs';
import { PublisherDirectory } from './publishers.mjs';
import { assertPersistentMount, describeConfig, resolveRuntimeConfig, ConfigurationError } from './config.mjs';
import { startIntelServer } from './server.mjs';

/**
 * Whether the configured store can be used right now.
 *
 * It reads one event count, which is a real query against the real collections: it needs the contract to be active
 * and the credential to be accepted, so it fails exactly when a write would fail. It does not write, so a readiness
 * probe never leaves anything behind.
 */
export function storageReadiness(events) {
  return async () => {
    try {
      await events.count();
      return { ready: true };
    } catch (error) {
      return { ready: false, detail: `${error?.code ?? error?.name ?? 'UNKNOWN'}: ${String(error?.message ?? error).slice(0, 300)}` };
    }
  };
}

const log = (entry) => process.stdout.write(`${JSON.stringify(entry)}\n`);

export async function main() {
  let config;
  try {
    config = resolveRuntimeConfig(process.env);
  } catch (error) {
    if (error instanceof ConfigurationError) {
      log({ event: 'configuration.invalid', problems: error.problems, at: new Date().toISOString() });
      process.exitCode = 78; // EX_CONFIG
      return null;
    }
    throw error;
  }

  let db;
  try {
    if (config.storage.embedded) {
      // Embedded FeltDB: the volume check comes before the database is opened, so nothing is ever written to a path
      // that would not survive. The contract is installed in-process (`prepare`), which is how a local store is governed.
      let mountinfo;
      try {
        mountinfo = readFileSync('/proc/self/mountinfo', 'utf8');
      } catch (error) {
        throw new ConfigurationError('cannot verify the embedded store is on a persistent volume', { problems: [`/proc/self/mountinfo is unreadable (${error.code}); embedded storage is only supported on Linux with a mounted volume.`] });
      }
      assertPersistentMount(config.storage.path, mountinfo);
      db = createFeltDB({ mode: 'local', namespace: config.storage.namespace, path: config.storage.path, access: 'shared' });
      await prepare(db);
    } else {
      db = createFeltDB();
    }
  } catch (error) {
    if (error instanceof ConfigurationError) {
      log({ event: 'configuration.invalid', problems: error.problems, at: new Date().toISOString() });
      process.exitCode = 78;
      return null;
    }
    throw error;
  }
  const publishers = new PublisherDirectory(db);
  const events = new EventAcceptor(db, publishers);
  const readiness = storageReadiness(events);

  // Said once at startup, so a deploy's log makes plain which authority this process is bound to, and whether that
  // authority answered. A process that starts unready is not an error: it serves /health, refuses /ready, and takes
  // no traffic until the authority is there.
  const probe = await readiness();
  log({ event: 'storage.checked', ready: probe.ready, ...(probe.detail ? { detail: probe.detail } : {}), ...describeConfig(config).storage, at: new Date().toISOString() });

  const running = await startIntelServer({
    config,
    publishers,
    events,
    readiness,
    log,
    onShutdown: async () => {
      await db.close?.().catch(() => {});
    },
  });
  return { ...running, db, config, publishers, events };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
