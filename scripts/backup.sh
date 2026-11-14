#!/bin/sh
# Back up Boundry Intel's embedded FeltDB on the host, and prove the backup restores.
#
#   sudo scripts/backup.sh [backup-dir]        default /var/backups/boundry-intel
#
# What it does, in order:
#   1. stops the container (graceful, 30 s), because FeltDB's embedded store is a snapshot plus journals that
#      compaction renames: a copy taken while it writes can capture files from two different moments;
#   2. archives the store directory from the volume, read-only, in a throwaway container with no network;
#   3. starts the container again: always, even if step 2 failed (trap), and waits for /ready;
#   4. verifies the archive by restoring it into a temporary directory inside a throwaway container and reading every
#      record with the same FeltDB build (scripts/verify-backup.mjs); the live volume is never opened;
#   5. writes <archive>.sha256 and <archive>.verify.json, and keeps the newest $KEEP verified archives.
#
# Downtime is the stop/archive/start window (seconds for a small store). Publishers get a 502 from Caddy during it
# and must resend; identity is (product.id, id), so a resend of anything already stored answers `duplicate`.
#
# A backup on the same host does not survive the loss of the host. Copy $DEST somewhere else.
set -eu

CONTAINER=${CONTAINER:-boundry-intel}
VOLUME=${VOLUME:-boundry_intel_data}
IMAGE=${IMAGE:-boundry-intel:local}
STORE_DIR=${STORE_DIR:-/data/intel}
READY_URL=${READY_URL:-http://127.0.0.1:21010/ready}
KEEP=${KEEP:-14}
DEST=${1:-/var/backups/boundry-intel}

STAMP=$(date -u +%Y%m%dT%H%M%SZ)
ARCHIVE="intel-$STAMP.tgz"
umask 077
mkdir -p "$DEST"

say() { printf '%s %s\n' "$(date -u +%H:%M:%SZ)" "$*" >&2; }

was_running=$(docker inspect -f '{{.State.Running}}' "$CONTAINER")
restarted=no
restart() {
  if [ "$was_running" = true ] && [ "$restarted" = no ]; then
    restarted=yes
    say "starting $CONTAINER"
    docker start "$CONTAINER" >/dev/null
  fi
}
trap restart EXIT

say "stopping $CONTAINER"
docker stop -t 30 "$CONTAINER" >/dev/null
say "archiving $VOLUME:$STORE_DIR to $DEST/$ARCHIVE"
docker run --rm --network none -v "$VOLUME:/data:ro" -v "$DEST:/backup" --entrypoint tar "$IMAGE" -czf "/backup/$ARCHIVE" -C "$STORE_DIR" .
restart
trap - EXIT

if [ "$was_running" = true ]; then
  i=0
  until curl -fsS -o /dev/null "$READY_URL"; do
    i=$((i + 1))
    if [ "$i" -ge 30 ]; then say "ERROR: $CONTAINER is not ready after restart; the archive was written"; exit 1; fi
    sleep 1
  done
  say "$CONTAINER is ready again"
fi

(cd "$DEST" && sha256sum "$ARCHIVE" > "$ARCHIVE.sha256")
say "verifying $ARCHIVE by restoring it in a throwaway container"
if docker run --rm --network none -v "$DEST:/backup:ro" "$IMAGE" node scripts/verify-backup.mjs "/backup/$ARCHIVE" > "$DEST/$ARCHIVE.verify.json"; then
  say "verified: $(tr -d '\n ' < "$DEST/$ARCHIVE.verify.json" | grep -o '"intel_events":{"count":[0-9]*' | grep -o '[0-9]*$') events restorable"
else
  say "ERROR: $ARCHIVE did not verify; see $DEST/$ARCHIVE.verify.json. It is kept, and nothing older was removed."
  exit 1
fi

# Rotation: only verified archives count, and only once this one has verified.
ls -1t "$DEST"/intel-*.tgz | while read -r old; do
  [ -f "$old.verify.json" ] && grep -q '"restorable": true' "$old.verify.json" && echo "$old"
done | tail -n +"$((KEEP + 1))" | while read -r old; do
  say "removing old backup $(basename "$old")"
  rm -f "$old" "$old.sha256" "$old.verify.json"
done
echo "$DEST/$ARCHIVE"
