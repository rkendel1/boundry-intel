#!/usr/bin/env node
/**
 * Proves a Boundry Intel backup can be restored, by restoring it: extract the archive into a fresh temporary
 * directory, open it with the same FeltDB build and application contract the service uses, and read every record.
 *
 * A tarball that exists is not a backup. This passes only when
 *   - the archive extracts,
 *   - FeltDB opens the extracted store and the Boundry Intel contract is active in it,
 *   - every collection can be read to the end, and
 *   - every stored event's envelope still produces the digest recorded when it was accepted.
 *
 * It never touches the live volume: it reads the archive file and writes only to its own temporary directory, which
 * it removes. Output is one JSON report on stdout; exit 0 when restorable, 1 when not, 2 on usage.
 *
 *   node scripts/verify-backup.mjs <archive.tgz> [--namespace intel] [--expect-events N]
 */
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createFeltDB } from '@feltdb/core';

import { BOUNDRY_INTEL_CONTRACT } from '../src/application.mjs';
import { eventDigest } from '../src/events.mjs';

const TIME_FIELD = { intel_events: 'receivedAt', intel_publishers: 'createdAt', registry_records: 'recordedAt', registry_revisions: 'supersededAt' };

export async function verifyBackup(archive, { namespace = 'intel', expectEvents } = {}) {
  const report = { archive, namespace, feltdb: feltdbVersion(), restorable: false, collections: {}, problems: [] };
  const dir = await mkdtemp(join(tmpdir(), 'boundry-intel-restore-'));
  let db;
  try {
    try {
      execFileSync('tar', ['-xzf', archive, '-C', dir], { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (error) {
      report.problems.push(`the archive does not extract: ${String(error.stderr ?? error.message).trim().slice(0, 300)}`);
      return report;
    }
    try {
      db = createFeltDB({ mode: 'local', namespace, path: dir, access: 'shared' });
      const active = await db.stateContract.active();
      if (!active) {
        report.problems.push('no application contract is active in the restored store: this is not a Boundry Intel store (or the namespace is wrong)');
        return report;
      }
    } catch (error) {
      report.problems.push(`FeltDB cannot open the restored store: ${error.code ?? error.name}: ${String(error.message).slice(0, 300)}`);
      return report;
    }

    for (const collection of Object.keys(BOUNDRY_INTEL_CONTRACT.collections)) {
      const field = TIME_FIELD[collection];
      let count = 0;
      let earliest = null;
      let latest = null;
      let mismatched = 0;
      let cursor;
      for (;;) {
        const page = await db.query({ collection, limit: 1000, ...(cursor ? { cursor } : {}) });
        for (const record of page.records) {
          count += 1;
          const at = record[field];
          if (at && (!earliest || at < earliest)) earliest = at;
          if (at && (!latest || at > latest)) latest = at;
          if (collection === 'intel_events' && eventDigest(record.event) !== record.digest) {
            mismatched += 1;
            if (mismatched <= 5) report.problems.push(`event ${record.reference} no longer matches its recorded digest`);
          }
        }
        if (page.exhausted || !page.nextCursor || page.records.length === 0) break;
        cursor = page.nextCursor;
      }
      report.collections[collection] = { count, earliest, latest, ...(collection === 'intel_events' ? { digestMismatches: mismatched } : {}) };
    }
    if (expectEvents !== undefined && report.collections.intel_events.count < expectEvents) {
      report.problems.push(`expected at least ${expectEvents} events, the backup holds ${report.collections.intel_events.count}`);
    }
    report.restorable = report.problems.length === 0;
    return report;
  } finally {
    await db?.close?.().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
}

function feltdbVersion() {
  try {
    return JSON.parse(readFileSync(new URL('../node_modules/@feltdb/core/package.json', import.meta.url), 'utf8')).version;
  } catch {
    return null;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const archive = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
  const option = (name) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  if (!archive) {
    process.stderr.write('usage: verify-backup <archive.tgz> [--namespace intel] [--expect-events N]\n');
    process.exitCode = 2;
  } else {
    const expect = option('expect-events');
    const report = await verifyBackup(archive, { namespace: option('namespace') ?? 'intel', ...(expect !== undefined ? { expectEvents: Number(expect) } : {}) });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = report.restorable ? 0 : 1;
  }
}
