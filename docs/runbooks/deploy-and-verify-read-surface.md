# Task: deploy the read surface, and find out what Boundry Intel actually holds

A self-contained brief for one operator or agent. **The outcome is a report of production facts**, not a deployment.
Deploying is only the means to reading the store.

## Constraints

- **Do not change production data.** Do not post events, issue or revoke publishers, assert registry documents, or
  edit anything under `/data`. Every command below either reads, or replaces the service image, which leaves the
  volume untouched.
- **Do not expose anything new.** No new published port. The app port stays on `127.0.0.1:21010`. No Caddy change is
  needed: Caddy already proxies every path, as the app's own JSON 404 on `/` shows.
- **No secret leaves the host.** The reader token is generated on the host, written only to
  `/opt/boundry-intel/env`, and used only from inside the container. Never print it, paste it into chat, or put it on
  a command line that is logged elsewhere.
- **Stop and roll back** at any failed check marked **STOP**.

## Who can run it

You need root over SSH on the Hetzner host (`intel.trythissoftware.com`, 95.217.199.123). The cloud session that wrote
this had no SSH access (port 22 refused, no key), so it could not run this. Steps 0 and 3 need a human decision.

## 0. Review and merge (human)

Review branch `claude/gracious-brown-977myd` and merge it into `main`. The changes: the read surface, attribution that
separates the verified credential from the claimed name, backup and restore with verification, and docs. There are
no contract or schema changes: `src/application.mjs` and every collection definition are untouched, so old and new
images read the same store. That is what makes step 7's rollback safe.

## 1. Record the starting state (read-only)

```bash
docker ps --filter name=boundry-intel --format '{{.Image}} {{.Status}} {{.Ports}}'
```

```bash
curl -s https://intel.trythissoftware.com/ready
```

```bash
ss -tlnp | grep -E ':(21010|8080)\b'
```

Expect the container to be up, `/ready` to answer `"status":"ready"`, and port 21010 bound to 127.0.0.1 only.

## 2. Build the new image beside the running one, then take a verified backup

From a checkout of merged `main`, upload the source (the running container does not use this directory):

```bash
tar czf - package.json package-lock.json Dockerfile .dockerignore src schema scripts | ssh root@intel.trythissoftware.com 'rm -rf /opt/boundry-intel/src-build && mkdir -p /opt/boundry-intel/src-build && tar xzf - -C /opt/boundry-intel/src-build'
```

On the host:

```bash
cd /opt/boundry-intel/src-build && docker build -q -t boundry-intel:next . && docker tag boundry-intel:local boundry-intel:previous
```

```bash
cd /opt/boundry-intel/src-build && IMAGE=boundry-intel:next sh scripts/backup.sh /var/backups/boundry-intel
```

The *old* container is stopped for a few seconds and started again. The new image only archives and verifies.
**STOP** if the script exits non-zero, or if `/var/backups/boundry-intel/<archive>.verify.json` does not say
`"restorable": true`. Record its event, publisher and registry counts: they are the first production numbers, taken
before anything changed.

## 3. Create the reader credential (human approves)

```bash
grep -q '^BOUNDRY_INTEL_READER_TOKEN=' /opt/boundry-intel/env || printf 'BOUNDRY_INTEL_READER_TOKEN=%s\n' "$(openssl rand -hex 32)" >> /opt/boundry-intel/env
```

```bash
grep -c '^BOUNDRY_INTEL_READER_TOKEN=' /opt/boundry-intel/env
```

Expect `1`. `ls -l /opt/boundry-intel/env` must still show mode `-rw-------`.

## 4. Deploy

```bash
docker tag boundry-intel:next boundry-intel:local && docker rm -f boundry-intel && docker run -d --name boundry-intel --restart unless-stopped --env-file /opt/boundry-intel/env -v boundry_intel_data:/data -p 127.0.0.1:21010:8080 boundry-intel:local
```

## 5. Verify the deployment

```bash
curl -s https://intel.trythissoftware.com/ready
```

**STOP** unless it is 200 and `"status":"ready"`.

```bash
for p in /appport/manifest /.well-known/appport; do curl -s -o /dev/null -w "$p %{http_code}\n" https://intel.trythissoftware.com$p; done; curl -s -o /dev/null -w "/mcp %{http_code}\n" -X POST https://intel.trythissoftware.com/mcp
```

**STOP** unless all three answer `401`. 404 means the old image is still running; 200 means the read surface is open.

```bash
docker logs boundry-intel 2>&1 | head -2
```

The `listening` line must show `"readBoundary":"operator and reader tokens"`.

```bash
ss -tlnp | grep -E ':(21010|8080)\b'
```

**STOP** if anything other than `127.0.0.1:21010` appears.

## 6. Read production (the point of the task)

Run every read inside the container, so the token comes from its environment and never appears on a command line:

```bash
intel() { docker exec boundry-intel sh -c 'BOUNDRY_INTEL_URL=http://127.0.0.1:8080 BOUNDRY_INTEL_TOKEN="$BOUNDRY_INTEL_READER_TOKEN" BOUNDRY_INTEL_AS=deploy-verify node scripts/intel.mjs "$@"' intel "$@"; }
```

```bash
intel status
```

```bash
intel diagnose
```

```bash
intel publishers
```

```bash
intel datasets
```

```bash
intel events --limit 10
```

```bash
intel registry --limit 10
```

Then confirm the token reached no log:

```bash
docker logs boundry-intel 2>&1 | grep -cF "$(grep '^BOUNDRY_INTEL_READER_TOKEN=' /opt/boundry-intel/env | cut -d= -f2-)"
```

**STOP** unless it prints `0`.

### What the evidence predicts, so the result can be checked against it

- **Real publishers: probably none.** No repository examined has a product posting to this service.
  `rkendel1/boundry`'s own docs say *"No product emits yet"*. Its emitter targets `boundry.company/api/intelligence/…`,
  not this host. `rkendel1/boundry-maint` collects package data on its own schedule and writes it to git; it does not
  post here. GitHub code search could not settle the question, because it does not index these repositories.
- **Test records: probably some.** Deployment §10 records that `accepted`, `duplicate`, `409` and refusals were
  exercised against the live URL on 2026-11-10. Expect at least one publisher created then, and its events. Report them
  as **verification traffic, not intelligence**: say so per publisher (by `name`, `createdBy`, `createdAt`) and per
  event (`type`, `occurredAt`).
- **Registry: empty.** Nothing in the service writes it.

If the result contradicts any of these, report the contradiction first: it means something publishes that the code
search did not find.

## 7. Roll back (only on a STOP after step 4)

```bash
docker rm -f boundry-intel && docker run -d --name boundry-intel --restart unless-stopped --env-file /opt/boundry-intel/env -v boundry_intel_data:/data -p 127.0.0.1:21010:8080 boundry-intel:previous
```

The data is not rolled back, because nothing changed it. The step 2 archive exists if it ever needs to be (restore
procedure: operator guide §7). A leftover `BOUNDRY_INTEL_READER_TOKEN` line is harmless to the previous image, which
ignores it.

## 8. Report

| Fact | Value | Source |
|---|---|---|
| Image deployed (`docker inspect -f '{{.Image}}' boundry-intel`) | | step 5 |
| Backup archive, sha256, `restorable` | | step 2 |
| Events: count, earliest and latest `receivedAt` | | `status` |
| Publishers: each with subject, name, createdBy, createdAt, state, latest event | | `publishers` |
| Which publishers are real products and which are verification traffic | | `publishers`, `events` |
| Registry records | | `datasets` |
| Freshness state | | `status` |
| Diagnostics findings | | `diagnose` |
| Unauthenticated read routes return 401 | | step 5 |
| App port bound to loopback only | | step 5 |
| Token in logs (must be 0) | | step 6 |
| STOPs hit and rollbacks done | | |

Report counts, ids, types and timestamps. Do not paste event `actor` contents: they may identify people.
