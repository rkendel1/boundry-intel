# Running Boundry Intelligence as a durable service

The runtime and storage decision, the evidence behind it, and the exact steps to deploy and roll back. Every claim
here was checked against the live systems on 2026-11-10; where something was not verified, it says so.

## 1. What the audit found, and what it corrects

| Claim carried in earlier documents | What is actually true |
|---|---|
| FeltDB `server:` mode is the remote option, unverified | There is no `server` mode. `FeltDBDeploymentMode` is `browser \| local \| remote \| memory`; the durable one is **`remote`**, configured with `FELTDB_URL`, `FELTDB_TOKEN`, `FELTDB_APPLICATION_ID`, `FELTDB_NAMESPACE`, `FELTDB_ENVIRONMENT` |
| The Fly control plane at `api.feltdb.com` may or may not be usable | It is **live and healthy**: `/health` answers `{"status":"healthy","version":"0.6.1","release_id":"0.21.0-…","deployment_id":"registry.fly.io/feltdb-control-plane:…"}`, and its release is 0.21.0 — the version this package pins |
| `prepare(db)` installs the contract wherever it runs | `prepare` works on a **local** store only. In `remote` mode `stateContract.active()` refuses with `CONTRACT_UNSUPPORTED`: *"This runtime does not hold an embedded state contract. A managed authority enforces the contract published to it."* The contract must be **published**, not evolved |
| A missing configuration is a startup error | It is **not**, by itself: `resolveFeltDBDeployment({})` answers `{ mode: 'local', path: '<cwd>/.feltdb/default', source: 'auto' }`. A service deployed with a misspelled variable would accept events and answer `accepted` while writing to a container filesystem. `src/config.mjs` exists to refuse that |

## 2. The decision

| | |
|---|---|
| **Storage** | FeltDB `remote` mode against the managed authority at `https://api.feltdb.com` (Fly), application `app_zQ6Ckl8wHg7F9oWbZ9`, namespace `tenant_bpWofSKiLMZyryxeUJ:intel-registry`, environment `production` |
| **Contract** | published and promoted to that application, not evolved by the process |
| **Runtime** | a single Node ≥ 20 process, `node src/main.mjs`, no build step, three dependencies |
| **Authentication inward** | publisher keys (`bik_…`) on `POST /v1/events`; a separate operator token on the publisher routes |
| **Authentication outward** | one FeltDB data-plane service key (`fdb_live_…`) in `FELTDB_TOKEN` |
| **Network topology** | the process makes outbound HTTPS to one public host. It needs no inbound access to anything private, no VPC, no tunnel |

**Why this storage and not another.** It is the only durable option that exists today. The authority is already
running, already on the matching release, and reachable over the public internet, so nothing new is provisioned and
nothing is spent. The planned Hetzner control plane was checked and is not part of this decision: no reachable
endpoint for it was found, and a service that cannot prove durable connectivity must not be deployed.

**Why the network topology matters more than the host.** Because the authority is a public HTTPS endpoint, the old
worry — that a serverless runtime could not reach a private FeltDB — does not apply. Any runtime that can make
outbound HTTPS and hold a secret can run this service. That widens the hosting choice rather than narrowing it, and
it is why the runtime decision is deliberately the least interesting part of this document.

**Why not the static site's project.** `boundry.company` stays static. This service holds a data-plane service key and
an operator token; putting those in the project that serves the marketing site would put a credential one
misconfiguration away from a public bundle. FeltDB's own guidance is the same: a service key must never reach a
`VITE_`/`NEXT_PUBLIC_` variable, and `@feltdb/core` throws `FeltDBBrowserCredentialError` if one does.

## 3. Required environment

| Variable | Required | Effect |
|---|---|---|
| `FELTDB_URL` | yes in production | the managed authority, `https://api.feltdb.com` |
| `FELTDB_TOKEN` | yes in production | data-plane service key, `fdb_live_…`. Needs the `state:read`, `state:write` and `application:revision:read` scopes |
| `FELTDB_APPLICATION_ID` | yes | `app_zQ6Ckl8wHg7F9oWbZ9` |
| `FELTDB_NAMESPACE` | yes | `tenant_bpWofSKiLMZyryxeUJ:intel-registry` |
| `FELTDB_ENVIRONMENT` | yes | `production` |
| `BOUNDRY_INTEL_ENV` | no | `production` turns on fail-closed checking; otherwise `NODE_ENV` is used |
| `BOUNDRY_INTEL_OPERATOR_TOKEN` | yes in production | at least 32 characters. Without it the publisher routes are **not mounted** |
| `PORT` | no | default 8080; `0` asks the operating system to choose |
| `BOUNDRY_INTEL_MAX_BODY_BYTES` | no | default 1 MiB |
| `BOUNDRY_INTEL_REQUEST_TIMEOUT_MS` | no | default 30 000 |

**Secrets never go in the repository.** `.env.local` and `.feltdb/` are git-ignored and written mode 600;
`FELTDB_MANAGED_CONTROL_API_KEY` is needed only to publish a contract, never by the running service. The service logs
the storage identity but never a token: `describeConfig` exists so a log line cannot carry one by accident, and a test
asserts that neither a publisher key nor the operator token appears in the log.

## 4. Health and readiness

`GET /health` answers 200 whenever the process can answer. It deliberately says nothing about storage, so a
platform's restart policy does not kill a process that is merely waiting for its authority.

`GET /ready` runs a real query against the real collections (`events.count()`) on **every** request, and answers 503
with the failure when it does not work. It needs the contract to be active and the credential to be accepted, so it
fails exactly when a write would fail. It writes nothing, so probing leaves nothing behind. Readiness is never cached:
a process whose authority goes away stops reporting itself ready without being restarted.

A production process with no durable storage configured **does not start**: `main` resolves the configuration first,
logs the problems, and exits 78 (`EX_CONFIG`) before a port is bound.

## 5. Failure behaviour

| What happens | What a publisher gets |
|---|---|
| validated, authorized, committed | `accepted`, with the canonical digest |
| same identity, same digest | `duplicate` |
| same identity, different content | `409 conflict`, nothing written |
| invalid under `boundry.event/1` | `400 rejected` with the issues, nothing written |
| unknown, revoked, wrong scope, another product's event | `403 unauthorized`, nothing written |
| storage failed | `503` `STORAGE_UNAVAILABLE` with `retryable: true` and **no digest** |

A storage failure is never an acknowledgement. Resending the same batch is safe because identity is
`(product.id, id)`: a resend of a stored event answers `duplicate`.

There is **no queue and no background retry** in this process. An in-memory queue would be somewhere accepted events
could disappear, and a background retry would be somewhere a publisher could be told `accepted` before anything
durable happened. The retry belongs to the publisher, which is why the answer says so.

## 6. Publishing the contract

A managed authority enforces the contract published to it. The contract is generated from the same
`boundryIntelStateContract()` the local tests enforce, so the published and local shapes cannot drift:

```bash
npm run contract        # writes boundry-intel.contract.json from src/application.mjs
```

```bash
node node_modules/.bin/feltdb init-managed --contract boundry-intel.contract.json --yes --approve-destructive-changes
```

The approval flag is required and should be: publishing sets the authorization boundary, and the authority refuses to
promote such a change silently. Its own words on the first attempt without it were *"Publish requires explicit
approval before activation (SECURITY_SENSITIVE, authorization boundary changed). Immutable version 1 was staged but
the active cloud version was not changed."*

**Policies.** The four collections each carry a policy with no `read` and no `write` subject, which grants end-user
sessions nothing. The valid subjects are `authenticated`, `owner`, `member` and `self(field)` — all session subjects.
This service is the only reader and writer, through its own service key and that key's scopes. Event records and
publisher key hashes must never be reachable from a browser session, so there is deliberately no `authenticated`
grant.

**Status.** Version 1 is published and promoted:
`apprev://tenant_bpWofSKiLMZyryxeUJ/app_zQ6Ckl8wHg7F9oWbZ9/sha256:e12deaf8ba5a1c883d0674114b1d95180cb068b8a419e77339edcad90c758c99`.

## 7. Deploying, and rolling back

The artifact is the repository: `package.json`, `src/`, `schema/`, and `npm ci --omit=dev` (three runtime
dependencies, no build step, no native code). Any runtime that runs Node ≥ 20, makes outbound HTTPS and holds
environment secrets can serve it.

```bash
npm ci --omit=dev
node src/main.mjs
```

Deploy:

1. Set the environment above on the target, with the service key as a secret.
2. Publish the contract once per application (§6). A later contract change is published the same way and needs the
   same explicit approval.
3. Start the process. Read its first two log lines: `storage.checked` says which authority it bound to and whether
   that authority answered; `listening` says the port and the resolved configuration, without secrets.
4. Confirm `GET /ready` is 200 before sending traffic.

Roll back:

- **The service**: deploy the previous commit. The process holds no state, so rolling back is only the artifact.
- **The contract**: versions are immutable and promotion is explicit, so a previous version is re-promoted rather
  than edited. Roll the service back first if the older contract lacks a collection the newer service writes.

## 8. What is verified, and what is not

Verified against the live authority:

- `api.feltdb.com` is healthy and on release 0.21.0.
- `/v1/application` and `/v1/transactions` exist and answer `401 AUTHENTICATION_REQUIRED` without a key, so the
  protocol surface is real and the failure mode is a credential, not a network path.
- The contract generated from `src/application.mjs` passes the authority's manifest validation, stages as an
  immutable version, and is promoted to `production`.
- The runtime key resolves the promoted revision (`feltdb init-managed` reports it).
- The service's own configuration resolution reports `mode: remote`, `durable: true` from this environment, and its
  readiness probe reports **unready** with the authority's exact reason while the key lacks scopes. That is the
  fail-closed behaviour working.

Verified locally, on a real FeltDB with the contract enforced:

- All five acceptance answers through the HTTP boundary, and that every refusal writes nothing.
- An unknown, revoked and wrongly-scoped key each refused; a repository publisher refused for its product's events.
- An accepted event committed before the response, read back through HTTP, and still present after the store is
  reopened in a new process, where the same key still authenticates and the resend answers `duplicate`.
- A storage failure answering `503` retryable with no digest, and nothing stored.
- Readiness failing with a reason; a production configuration refusing `local`, refusing an explicit local path, and
  refusing `remote` with no token.
- The operator boundary refusing unauthenticated issue, revoke and list; requiring an operator name; returning a key
  once; revocation taking effect on the next request; and no key, token or event content reaching the log.

**Not verified:**

- **A durable write through the deployed service.** The runtime key is accepted but lacks the scopes the authority
  names (`state:read`, `application:revision:read`, and write). Minting a key with those scopes needs an action this
  session is not permitted to take (§9).
- **The service running on a hosting platform.** No deployment credentials exist in this environment and no
  deployment CLI is installed, so nothing was deployed anywhere. The artifact runs, its configuration resolves
  against the real authority, and its readiness probe reports the real reason it is not ready.
- **Restart and recovery against the managed authority.** Proven on a local store; the remote equivalent waits on the
  key.
- Per-tenant row-level isolation inside one application. Still not implemented; separate namespaces remain the
  boundary.

## 9. The blocker, exactly

The contract is live. The one thing between this and a durable remote write is a data-plane key with the right scopes.
The authority's own words:

> The credential was accepted but is not authorized for application "app_zQ6Ckl8wHg7F9oWbZ9" in environment
> "production". Use a data key minted for this application with the application:revision:read and state:read scopes.

The key in `FELTDB_TOKEN` was minted with `minimal` scopes. Minting a replacement is one command, which signs in with
the FeltDB account and writes the new key to `.env.local` (mode 600, git-ignored):

```bash
FELTDB_MANAGED_EMAIL=<account> FELTDB_MANAGED_PASSWORD=<password> node node_modules/.bin/feltdb managed keys create --name boundry-intel-runtime --scopes default --env-var FELTDB_TOKEN --save-to .env.local
```

Afterwards, `GET /ready` should answer 200 and the durable round-trip can be proven end to end.

Separately, deploying to a hosting platform needs that platform's credentials, which are not in this environment.

## 10. Where it runs now: Hetzner, embedded FeltDB (2026-11-10)

**This section supersedes §2, §3, §6, §7 and §9**, which describe the managed-authority design that was abandoned.

The service runs as the Docker container `boundry-intel` on the Hetzner host, at `https://intel.trythissoftware.com`,
behind Caddy, bound to `127.0.0.1:21010`. Storage is an **embedded FeltDB** (`FELTDB_MODE=local`,
`FELTDB_PATH=/data/intel`) on the Docker volume `boundry_intel_data`. The managed authority is not used and the Fly app
is gone.

**Why embedded.** The managed authority refused the runtime key's collection reads (HTTP 403) although the key was valid
and its scopes correct; `/v1/application` answered 200 with it. The cause was not isolated. The contract's policies have
empty `capabilities`, and the authority says it "refuses every read and write a policy does not allow", so policy is
the leading suspect. The §6 claim that empty policies leave the service key unaffected was never verified.

**The fail-closed rule is kept.** A production `local` store is refused unless `BOUNDRY_INTEL_STORAGE=embedded` is set,
`FELTDB_PATH` is absolute, **and the path is on a mounted volume** (checked against `/proc/self/mountinfo`). A path on
the container root filesystem exits 78 before a port is bound.

**Host layout.** Env file `/opt/boundry-intel/env` (mode 600, holds the operator token). Build context
`/opt/boundry-intel/src-build`. Caddy site in `/etc/caddy/Caddyfile`.

```bash
# redeploy from this repo
tar czf - package.json package-lock.json Dockerfile .dockerignore src schema | ssh root@<host> 'rm -rf /opt/boundry-intel/src-build && mkdir -p /opt/boundry-intel/src-build && tar xzf - -C /opt/boundry-intel/src-build'
ssh root@<host> 'cd /opt/boundry-intel/src-build && docker build -q -t boundry-intel:local . && docker rm -f boundry-intel; docker run -d --name boundry-intel --restart unless-stopped --env-file /opt/boundry-intel/env -v boundry_intel_data:/data -p 127.0.0.1:21010:8080 boundry-intel:local'
```

**Limits.** One host, one volume, no backups configured: snapshot `boundry_intel_data` if the data matters. The container
runs as root (volume ownership).

**Verified on the live URL:** health and readiness (embedded, durable); `accepted`, `duplicate`, `409 conflict`, unauthorized
and other-product `403`, invalid `400`, with nothing stored for refusals; the event surviving a container restart and
the replay answering `duplicate`; no key or token in the log. **Not re-run on the host:** the storage-failure case
(covered by a unit test).
