# Operator guide: what Boundry Intel holds, and how to read it

This is the guide to finding out whether Boundry Intel is running, whether it has received anything, and how to read,
export and diagnose what it holds, for a person at a terminal or an agent over MCP. One set of read capabilities
serves both.

Each command below says where it was verified. **Local** means against the real service process (`node src/main.mjs`)
on a real FeltDB, including the production embedded configuration. **Live** means against
`https://intel.trythissoftware.com`. Nothing here was run on the Hetzner host itself: this guide was written without
SSH access to it.

## 0. What the system is, in one paragraph

Boundry Intel collects nothing on its own. It is a **push** service: an authenticated *publisher* (a key bound to one
product) POSTs `boundry.event/1` envelopes to `/v1/events`, and each valid, authorized envelope is committed once,
verbatim, with its digest. A refused envelope is **never stored**. The registry collections (`registry_records`,
`registry_revisions`) are part of the same database, but the running service has **no route that writes them**: they
fill only when code uses `RegistryStore` directly. So "is it collecting?" means "is any publisher posting, and is it
being accepted?"

| Dataset | What it is | Kind |
|---|---|---|
| `intel_events` | accepted events, verbatim, with publisher, `receivedAt` and digest | raw observation |
| `intel_publishers` | who may post, for which product, issued by whom, revoked or not, last used | identity |
| `registry_records` | current registry documents with provenance | normalized record |
| `registry_revisions` | superseded registry documents | history |

Nothing is ever deleted. There is no retention sweep. Storage is an embedded FeltDB at `/data/intel` on the Docker
volume `boundry_intel_data` (deployment §10). **No backups are configured.**

## 1. Is it running?

No credential needed.

```bash
curl -s https://intel.trythissoftware.com/health
```

```bash
curl -s https://intel.trythissoftware.com/ready
```

`/health` 200 means the process answers. `/ready` 200 means it ran a real query against its storage just now; 503
carries the reason. *Verified live, 2026-11-11:* `{"status":"alive"}` and
`{"status":"ready","storage":{"mode":"local","namespace":"intel","durable":true,"embedded":true,"path":"/data/intel"}}`.

## 2. Credentials

| Credential | Env var on the host | Can |
|---|---|---|
| operator token | `BOUNDRY_INTEL_OPERATOR_TOKEN` | issue/revoke publishers, **and** read everything below |
| reader token | `BOUNDRY_INTEL_READER_TOKEN` (optional, ≥ 32 chars, must differ from the operator token) | read everything below, **nothing else** |
| publisher key `bik_…` | issued by an operator | post events for its own product; cannot read this surface |

Both tokens live only in `/opt/boundry-intel/env` (mode 600) on the host. Give agents and dashboards the **reader**
token. No token or key is ever logged.

**What the audit log can prove.** Every read must also send `Boundry-Operator: <name>`, and is logged as:

```json
{"event":"intel.read","capability":"intel.status","authenticated":"credential:reader","claimedName":"<name>","requestId":"…"}
```

`authenticated` is verified: it names the credential that was presented. `claimedName` is **not** verified. Anyone
holding the reader token can send any name. Publisher issue and revoke are logged the same way
(`"authenticated":"credential:operator","claimedName":…`). The `createdBy` stored on a publisher record is that same
claimed label. While one reader token is shared, the log can tell reader reads from operator reads, and nothing finer.
Per-person or per-agent identity needs one credential per holder; it is not built.

To add a reader token (on the host):

```bash
echo "BOUNDRY_INTEL_READER_TOKEN=$(openssl rand -base64 36 | tr -d '/+=')" >> /opt/boundry-intel/env
```

The container reads the file at start, so redeploy (deployment §10) for it to take effect.

## 3. Reading the data

The service exposes the read capabilities three ways. All three are the same AppPort application, with the same
limits and the same authorization:

| Surface | Path | For |
|---|---|---|
| CLI | `npm run intel -- <command>` (in this repo, or `node scripts/intel.mjs` in the container) | people |
| AppPort | `GET /.well-known/appport`, `GET /appport/manifest`, `POST /appport` | any AppPort client |
| MCP | `POST /mcp` (Streamable HTTP, stateless) | agents |

CLI setup:

```bash
export BOUNDRY_INTEL_URL=https://intel.trythissoftware.com
export BOUNDRY_INTEL_TOKEN=<reader token>
export BOUNDRY_INTEL_AS=<your name>
```

| Question | Command | Capability |
|---|---|---|
| Is it healthy, how much does it hold, how fresh is it? | `npm run intel -- status` | `intel.status` |
| What datasets exist, what do the fields mean? | `npm run intel -- datasets` | `intel.datasets.list` |
| Latest events | `npm run intel -- events --limit 20` | `intel.events.list` |
| Filter | `npm run intel -- events --product feltdb --type capability.invoked --after 2026-11-01T00:00:00Z` | `intel.events.list` |
| Next page | `npm run intel -- events --limit 20 --cursor <nextCursor>` (same filters) | `intel.events.list` |
| One event, with provenance and an integrity check | `npm run intel -- event feltdb evt_…` | `intel.events.get` |
| Who sends data, and are they still sending? | `npm run intel -- publishers` | `intel.publishers.list` |
| Registry | `npm run intel -- registry --kind product` and `npm run intel -- record product:feltdb` | `intel.registry.*` |
| Why is data missing or stale? | `npm run intel -- diagnose` | `intel.diagnostics` |
| Export | `npm run intel -- export events --product feltdb --out feltdb-events.json` | `intel.events.list`, paged |
| What can an agent call? | `npm run intel -- capabilities` | AppPort manifest |

*Verified locally* (every command, against `node src/main.mjs` with both tokens set): output as described, a reader
refused (401) at `POST /v1/publishers`, and no token in the log.

**Limits.** A page holds 1–200 records (default 50). The service decides which filters exist; you cannot send a
query, a collection name or a field name. Filters are `--product --type --correlation --publisher --after --before`,
plus `--oldest` to reverse the order. A cursor belongs to the query that produced it, page size included. Change any
filter and you start without one. Events that arrived in one batch share a `receivedAt`. FeltDB orders them by storage
id: stable, but not their position in the batch.

**Export.** Export pages through `intel.events.list` (or `intel.registry.list`) 200 records at a time, up to `--max`
(default 10 000). It writes one JSON document, mode 600:
`{exportedAt, capability, filter, pages, count, complete, resumeCursor?, events: [...]}`. Every record keeps its
`reference`, `eventId`, `productId`, `occurredAt`, `receivedAt`, `publisherId`, `digest` and the verbatim envelope. When
`complete` is false, the export stopped at the last whole page within `--max`.

**Provenance.** `event <product> <id>` returns `provenance.publisher` (subject, scopes, `createdBy`, revocation, last use)
and `provenance.integrity` (the stored digest, the digest recomputed from the stored envelope, and whether they match).
A publisher key proves *who sent* an event, not that its content is true. The answer says so.

## 4. Agents (MCP)

Point an MCP client at `https://intel.trythissoftware.com/mcp`, with the headers
`Authorization: Bearer <reader token>` and `Boundry-Operator: <agent name>`. The tools are generated from the AppPort
manifest by `@appport/mcp`, so they cannot drift from it:

`intel_status`, `intel_datasets_list`, `intel_events_list`, `intel_events_get`, `intel_publishers_list`,
`intel_registry_list`, `intel_registry_get`, `intel_diagnostics`.

Each tool carries its input and output JSON Schema, including the page limit. Every tool is an `observation`. None
writes, and none takes free-form queries. Without valid headers the endpoint answers 401 before MCP sees the request.
In Claude Code:

```bash
claude mcp add --transport http boundry-intel https://intel.trythissoftware.com/mcp --header "Authorization: Bearer $BOUNDRY_INTEL_TOKEN" --header "Boundry-Operator: claude-code"
```

*Verified locally:* `tools/list` and `tools/call` over `POST /mcp` against the running process. The `claude mcp add`
line was not run.

## 5. Diagnosing missing or stale data

Run `npm run intel -- diagnose`. Each finding has a severity, a code and the evidence it rests on:

| Code | Meaning | Next step |
|---|---|---|
| `STORAGE_UNREADY` | storage query failed (detail included) | `docker logs boundry-intel`, check the volume |
| `NO_PUBLISHERS` / `ALL_PUBLISHERS_REVOKED` | nothing is allowed to post | issue a publisher (README, "Publishers") |
| `PUBLISHER_NEVER_USED` | a key was issued but never delivered anything | the product was never wired to post |
| `PUBLISHER_IDLE` | a publisher was silent longer than `--stale-after` (default 86 400 s) | check that product's emitter |
| `DATA_STALE` | the newest event is older than the threshold | as above |
| `REFUSALS_SINCE_START` | submissions were refused (tally and the last 50, with issue codes) | fix the sender; refusals are not stored |
| `STORAGE_FAILURES_SINCE_START` | a write failed with 503 | storage; the sender should resend |
| `REGISTRY_EMPTY` | no registry records (expected: nothing in the service writes them) | none, unless you expect them |

**The refusal tally is in memory.** It starts empty when the process starts, and every answer marks it
`durable: false`. Beyond it, the only record of refused or failed ingestion is the container log: one
`{"event":"request","path":"/v1/events","status":…}` line per request, plus `storage.unavailable` lines. On the host:

```bash
docker logs --since 24h boundry-intel 2>&1 | grep '"path":"/v1/events"'
```

*(Host command, not run. There was no SSH access when this guide was written.)*

## 6. Direct access on the host (diagnosis only)

The database is an embedded FeltDB inside the container. It has no network port, and none should be opened. If the
HTTP surface is down, read through the same code on the host:

```bash
docker exec -e BOUNDRY_INTEL_URL=http://127.0.0.1:8080 -e BOUNDRY_INTEL_TOKEN="$TOKEN" -e BOUNDRY_INTEL_AS=root boundry-intel node scripts/intel.mjs status
```

That still goes through the service and its authorization. Stop the container before copying the volume
(`boundry_intel_data`) for a snapshot.

## 7. Backup and restore

The store holds the only copy of every accepted event and every publisher record. There are no automatic backups.
Run this on the host, from the deployed source directory:

```bash
cd /opt/boundry-intel/src-build && sh scripts/backup.sh /var/backups/boundry-intel
```

It stops the container (FeltDB's files are only consistent at rest), archives `/data/intel` from the volume read-only,
starts the container again (always, even when archiving fails), waits for `/ready`, and then **proves the archive
restores**. It extracts the archive into a throwaway container with no network, opens it with the same FeltDB build, and
reads every record. Every event's envelope must still match its acceptance digest. Next to each archive it writes
`.sha256` and `.verify.json` (counts, time ranges, the FeltDB version, problems). It keeps the newest 14 *verified*
archives (`KEEP=`). Expect a few seconds of downtime. Publishers get a 502 during it and must resend, which is safe:
a resend of a stored event answers `duplicate`.

To check any archive again:

```bash
docker run --rm --network none -v /var/backups/boundry-intel:/backup:ro boundry-intel:local node scripts/verify-backup.mjs /backup/<archive>.tgz
```

**Restore never overwrites the live volume.** Restore into a new volume, check it on a loopback port, then switch:

```bash
docker volume create boundry_intel_restore
```

```bash
docker run --rm --network none -v boundry_intel_restore:/data -v /var/backups/boundry-intel:/backup:ro --entrypoint sh boundry-intel:local -c 'mkdir -p /data/intel && tar -xzf /backup/<archive>.tgz -C /data/intel'
```

```bash
docker run -d --name boundry-intel-restore --env-file /opt/boundry-intel/env -v boundry_intel_restore:/data -p 127.0.0.1:21011:8080 boundry-intel:local
```

```bash
docker exec -e BOUNDRY_INTEL_URL=http://127.0.0.1:8080 -e BOUNDRY_INTEL_TOKEN="$TOKEN" -e BOUNDRY_INTEL_AS=restore-drill boundry-intel-restore node scripts/intel.mjs status
```

For a **drill**, compare those counts with the `.verify.json`, then remove `boundry-intel-restore` and its volume. For a
**real restore**, stop and remove `boundry-intel` and run it again with `-v boundry_intel_restore:/data` on
`127.0.0.1:21010` (deployment §10). Keep the old volume until the restored service has been verified.

**Limits.** A backup on the same disk does not survive losing the host. Copy `/var/backups/boundry-intel` off the host;
that is not set up. Restore with an image whose `@feltdb/core` is at least the version in `.verify.json`: FeltDB refuses
a store written in a newer format.

*Verified:* in tests (`test/backup.test.mjs`) on a real FeltDB in the production namespace. A backup restores with
every record. The restored store authenticates the same publisher key and answers `duplicate` to a resend. A truncated
archive, an archive with no store, a file altered on disk (FeltDB refuses it) and a record whose envelope no longer
matches its digest all fail verification. `backup.sh`'s ordering (stop, archive, start, verify) and its restart after
a failed archive were checked with a stand-in for `docker`. **Not verified:** the Docker commands themselves, on the
host or anywhere (no Docker daemon was available).

