/**
 * Backup and restore, proved by restoring.
 *
 * The store here is a real embedded FeltDB under the production namespace (`intel`) with the application contract
 * installed, exactly as `main.mjs` opens it on the host. A backup is the store directory archived while the store is
 * closed; it counts as good only if `verifyBackup` can restore it and read every record, and a restored store must
 * still work as the service: the same publisher key authenticates and a resend answers `duplicate`.
 *
 * `scripts/backup.sh` runs on the host against Docker. There is no Docker daemon in CI, so its control flow is checked
 * with a stand-in `docker` on PATH that performs the same archive and verify steps on local directories. What that
 * proves is the ordering (stop → archive → start → verify) and that the container is started again when archiving
 * fails. It does not prove Docker's own behaviour.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createFeltDB } from '@feltdb/core';

import { prepare } from '../src/application.mjs';
import { EventAcceptor } from '../src/acceptance.mjs';
import { PublisherDirectory } from '../src/publishers.mjs';
import { RegistryStore } from '../src/store.mjs';
import { verifyBackup } from '../scripts/verify-backup.mjs';
import { envelope, docs } from './support.mjs';

const REPO = new URL('..', import.meta.url).pathname;

async function store(path) {
  const db = createFeltDB({ mode: 'local', namespace: 'intel', path, access: 'shared' });
  await prepare(db);
  const publishers = new PublisherDirectory(db);
  return { db, publishers, events: new EventAcceptor(db, publishers), registry: new RegistryStore(db) };
}

/** A populated production-shaped store, closed, ready to archive. */
async function populated() {
  const dir = await mkdtemp(join(tmpdir(), 'intel-live-'));
  const s = await store(dir);
  const { key } = await s.publishers.issue({ subject: 'product:feltdb', name: 'feltdb', scopes: ['events:write'], createdBy: 'operator:test' });
  const sent = Array.from({ length: 25 }, (_, i) => envelope({ id: `evt_${String(i + 1).padStart(8, '0')}` }));
  const answers = await s.events.accept(key, sent);
  assert.ok(answers.every((a) => a.status === 'accepted'));
  assert.equal((await s.registry.assert(docs.product())).status, 'recorded');
  await s.db.close();
  return { dir, key, sent };
}

const archive = async (dir) => {
  const out = join(await mkdtemp(join(tmpdir(), 'intel-backups-')), 'intel.tgz');
  execFileSync('tar', ['-czf', out, '-C', dir, '.']);
  return out;
};

test('a backup restores to a store holding every record, and the restored store still serves', async () => {
  const live = await populated();
  const file = await archive(live.dir);
  try {
    const report = await verifyBackup(file, { expectEvents: 25 });
    assert.equal(report.restorable, true, JSON.stringify(report.problems));
    assert.equal(report.collections.intel_events.count, 25);
    assert.equal(report.collections.intel_events.digestMismatches, 0);
    assert.equal(report.collections.intel_publishers.count, 1);
    assert.equal(report.collections.registry_records.count, 1);
    assert.ok(report.collections.intel_events.earliest && report.collections.intel_events.latest);
    assert.match(report.feltdb, /^\d+\.\d+\.\d+/, 'the report names the FeltDB build that read it');

    // Restore for real and use it.
    const restored = await mkdtemp(join(tmpdir(), 'intel-restored-'));
    execFileSync('tar', ['-xzf', file, '-C', restored]);
    const s = await store(restored);
    assert.ok(await s.publishers.authenticate(live.key), 'the same publisher key authenticates after restore');
    assert.deepEqual((await s.events.get('feltdb', 'evt_00000013')).event, live.sent[12]);
    assert.equal((await s.events.accept(live.key, [live.sent[0]]))[0].status, 'duplicate', 'a resend after restore is idempotent');
    await s.db.close();
    await rm(restored, { recursive: true, force: true });

    // Verification never changed the original.
    const again = await store(live.dir);
    assert.equal(await again.events.count(), 25);
    await again.db.close();
  } finally {
    await rm(live.dir, { recursive: true, force: true });
  }
});

test('a damaged archive, an archive with no store in it, and a backup short of an expected minimum are all refused', async () => {
  const live = await populated();
  try {
    const file = await archive(live.dir);
    const bytes = await readFile(file);
    const damaged = file.replace('.tgz', '-damaged.tgz');
    await writeFile(damaged, bytes.subarray(0, Math.floor(bytes.length / 2)));
    const d = await verifyBackup(damaged);
    assert.equal(d.restorable, false);

    const emptyDir = await mkdtemp(join(tmpdir(), 'intel-empty-'));
    const e = await verifyBackup(await archive(emptyDir));
    assert.equal(e.restorable, false);
    assert.match(e.problems.join(' '), /contract/);

    const short = await verifyBackup(file, { expectEvents: 1000 });
    assert.equal(short.restorable, false, 'an expected minimum that the backup does not meet fails it');
  } finally {
    await rm(live.dir, { recursive: true, force: true });
  }
});

test('an altered backup is refused, at the file layer by FeltDB and at the record layer by the event digest', async () => {
  // Layer 1: bytes changed on disk. FeltDB's journal records carry their own digests and it refuses to open.
  const files = await populated();
  try {
    let changed = false;
    for (const name of await readdir(files.dir)) {
      const path = join(files.dir, name);
      const text = await readFile(path, 'utf8').catch(() => null);
      if (text?.includes('collections.query')) {
        await writeFile(path, text.replace('collections.query', 'collections.qverY'));
        changed = true;
        break;
      }
    }
    assert.ok(changed, 'the test found a stored envelope to alter');
    const report = await verifyBackup(await archive(files.dir));
    assert.equal(report.restorable, false);
    assert.match(report.problems.join(' '), /CORRUPT_DURABLE_JOURNAL/);
  } finally {
    await rm(files.dir, { recursive: true, force: true });
  }

  // Layer 2: a record rewritten through FeltDB itself, so the store is internally consistent but the envelope no
  // longer matches the digest recorded at acceptance. Only the application digest can catch this.
  const records = await populated();
  try {
    const s = await store(records.dir);
    const [record] = (await s.db.query({ collection: 'intel_events', where: [{ field: 'eventId', eq: 'evt_00000003' }], limit: 1 })).records;
    const { __version, ...rest } = record;
    await s.db.transaction({ operations: [{ collection: 'intel_events', id: record.id, expectedVersion: __version, value: { ...rest, event: { ...rest.event, outcome: { status: 'failed' } } } }] });
    await s.db.close();
    const report = await verifyBackup(await archive(records.dir));
    assert.equal(report.restorable, false);
    assert.equal(report.collections.intel_events.digestMismatches, 1);
    assert.match(report.problems[0], /evt_00000003 no longer matches its recorded digest/);
  } finally {
    await rm(records.dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------ the host script's control flow ------------------------------------------------ */

async function fakeHost({ storeDir, failArchive = false }) {
  const bin = await mkdtemp(join(tmpdir(), 'intel-fakebin-'));
  const dest = await mkdtemp(join(tmpdir(), 'intel-dest-'));
  const log = join(bin, 'calls.log');
  // A stand-in for docker that records each call and does what the real one would to local directories.
  await writeFile(
    join(bin, 'docker'),
    `#!/bin/sh
echo "$1" >> "${log}"
case "$1" in
  inspect) echo true ;;
  stop|start) : ;;
  run)
    case "$*" in
      *"--entrypoint tar"*) ${failArchive ? 'exit 3' : `name=$(echo "$*" | sed -n 's#.*-czf /backup/\\([^ ]*\\).*#\\1#p'); tar -czf "${dest}/$name" -C "${storeDir}" .`} ;;
      *verify-backup.mjs*) name=$(echo "$*" | sed -n 's#.*verify-backup.mjs /backup/\\([^ ]*\\).*#\\1#p'); node "${REPO}scripts/verify-backup.mjs" "${dest}/$name" ;;
    esac ;;
esac
`,
  );
  await writeFile(join(bin, 'curl'), '#!/bin/sh\nexit 0\n');
  await chmod(join(bin, 'docker'), 0o755);
  await chmod(join(bin, 'curl'), 0o755);
  const result = spawnSync('sh', [join(REPO, 'scripts/backup.sh'), dest], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, encoding: 'utf8' });
  const calls = (await readFile(log, 'utf8')).trim().split('\n');
  return { result, calls, dest, cleanup: () => Promise.all([rm(bin, { recursive: true, force: true }), rm(dest, { recursive: true, force: true })]) };
}

test('backup.sh stops, archives, starts, then verifies, and leaves a checksum and a verification report', async () => {
  const live = await populated();
  const host = await fakeHost({ storeDir: live.dir });
  try {
    assert.equal(host.result.status, 0, host.result.stderr);
    assert.deepEqual(host.calls, ['inspect', 'stop', 'run', 'start', 'run']);
    const files = (await readdir(host.dest)).sort();
    assert.equal(files.length, 3);
    const report = JSON.parse(await readFile(join(host.dest, files.find((f) => f.endsWith('.verify.json'))), 'utf8'));
    assert.equal(report.restorable, true);
    assert.equal(report.collections.intel_events.count, 25);
    assert.match(host.result.stderr, /verified: 25 events restorable/);
  } finally {
    await host.cleanup();
    await rm(live.dir, { recursive: true, force: true });
  }
});

test('backup.sh starts the container again when archiving fails', async () => {
  const live = await populated();
  const host = await fakeHost({ storeDir: live.dir, failArchive: true });
  try {
    assert.notEqual(host.result.status, 0);
    assert.deepEqual(host.calls, ['inspect', 'stop', 'run', 'start'], 'stopped, failed, and started again: never left down');
  } finally {
    await host.cleanup();
    await rm(live.dir, { recursive: true, force: true });
  }
});
