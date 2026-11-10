#!/bin/bash
# One-command deploy: copies the project to the UAT server, rebuilds it, applies any new
# database changes, and restarts it. Run this from your Mac any time you want to push updates.
set -e

SERVER_USER="rounak_uat"
SERVER_HOST="200.97.170.143"
SERVER_PATH="/home/worklog/chatbot"
# The live containers were created back when this directory was named "builder-chatbot" (since
# renamed to "chatbot" — see git history/chat log) — Compose's project name is sticky per-project,
# not derived fresh from the current directory name each run, so every compose command below must
# pass -p explicitly or it infers "chatbot" from the new dirname and spins up a SECOND, colliding
# stack on the same hardcoded host ports instead of updating the real one (hit this once, 2026-10-30).
COMPOSE_PROJECT="builder-chatbot"
SSH_KEY="$HOME/.ssh/id_ed25519_finfinity"
LOCAL_PATH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/"

echo "==> Copying files to the server..."
# These never leave this Mac, regardless of what .gitignore says — rsync copies whatever's on
# disk, git-ignored or not, so a real test customer's data (cibil_profile.txt) and local junk
# (dump.rdb, the raw source spreadsheets) need their own explicit excludes here too (security-review
# finding, 2026-10-23).
# --no-perms/--no-times/--no-owner/--no-group/--omit-dir-times: some files on the server are
# pre-existing and owned by a different account (systemadmin2) from before shared group write
# access was set up for this account — we can still overwrite their CONTENTS (group-writable
# directory), but not chmod/chown/touch-them, which plain -a tries to do and fails on (exit 23).
# None of that metadata matters for this deploy, so just skip it instead of preserving it.
rsync -rlvz --delete \
  --no-perms --no-times --no-owner --no-group --omit-dir-times \
  --exclude 'node_modules' \
  --exclude 'dist' \
  --exclude '.git' \
  --exclude 'cibil_profile.txt' \
  --exclude '*.xlsx' \
  --exclude 'dump.rdb' \
  --exclude '.claude' \
  -e "ssh -i $SSH_KEY" \
  "$LOCAL_PATH" "$SERVER_USER@$SERVER_HOST:$SERVER_PATH/"

# The rsync above just overwrote test-page/index.html with OUR LOCAL copy, which points
# data-api-base at this Mac's own LAN IP (right for local dev, wrong for the deployed page) — fixed
# in place on the server BEFORE the image build below, since the Dockerfile now COPYs test-page
# into the image (it's served by the API server itself, not a separate process) — fixing it only
# after the build, like this used to, bakes the wrong value into the image instead (hit this for
# real, 2026-10-30: the live page called a LAN IP that doesn't exist from the server's network).
# Points at the public HTTPS domain (which Apache reverse-proxies to :8091 — see the
# finbuddy.uatfinfinity.in vhost), not the bare IP:8091 — a plain http://IP:port call from this
# https:// page would get blocked by the browser as mixed content anyway.
PUBLIC_API_BASE="https://finbuddy.uatfinfinity.in"
echo "==> Pointing the test page at the public API before building..."
ssh -i "$SSH_KEY" "$SERVER_USER@$SERVER_HOST" "cd $SERVER_PATH/test-page && sed -i -E 's#data-api-base=\"http://[^\"]+\"#data-api-base=\"$PUBLIC_API_BASE\"#' index.html sdk-demo.html embed.html"

echo "==> Building the new image on the server (not yet live)..."
ssh -i "$SSH_KEY" "$SERVER_USER@$SERVER_HOST" "cd $SERVER_PATH && docker compose -p $COMPOSE_PROJECT build server"

# Security-review finding, 2026-10-23: this used to restart the server with the NEW code first, and
# only run migrations after — a real window where new code (expecting the new schema) ran against
# the OLD database schema. `docker compose run` starts a short-lived, one-off container from the
# image just built above WITHOUT touching the long-running `server` service that's still serving
# real traffic on the OLD code/schema — so the migration lands before anything new goes live, and
# the live container only gets swapped to the new code (via `up -d` below) once the DB already
# matches it.
echo "==> Applying any new database changes (before the new code goes live)..."
ssh -i "$SSH_KEY" "$SERVER_USER@$SERVER_HOST" "cd $SERVER_PATH && docker compose -p $COMPOSE_PROJECT run --rm server npx prisma migrate deploy --schema prisma/schema.prisma"

echo "==> Restarting with the new code..."
ssh -i "$SSH_KEY" "$SERVER_USER@$SERVER_HOST" "cd $SERVER_PATH && docker compose -p $COMPOSE_PROJECT up -d"

echo "==> Checking it's alive..."
sleep 3
ssh -i "$SSH_KEY" "$SERVER_USER@$SERVER_HOST" "curl -s -o /dev/null -w 'API responded with HTTP %{http_code}\n' -X POST http://localhost:8091/api/chat/message -H 'Content-Type: application/json' -d '{}'"
ssh -i "$SSH_KEY" "$SERVER_USER@$SERVER_HOST" "curl -s -o /dev/null -w 'Demo page responded with HTTP %{http_code}\n' http://localhost:8091/"

echo "==> Done. Live at https://finbuddy.uatfinfinity.in"
