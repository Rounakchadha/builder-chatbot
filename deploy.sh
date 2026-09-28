#!/bin/bash
# One-command deploy: copies the project to the UAT server, rebuilds it, applies any new
# database changes, and restarts it. Run this from your Mac any time you want to push updates.
set -e

SERVER_USER="rounak_uat"
SERVER_HOST="200.97.170.143"
SERVER_PATH="/home/worklog/finfinity/version1-basic-flow"
SSH_KEY="$HOME/.ssh/id_ed25519_finfinity"
LOCAL_PATH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/"

echo "==> Copying files to the server..."
rsync -avz --delete \
  --exclude 'node_modules' \
  --exclude 'dist' \
  --exclude '.git' \
  -e "ssh -i $SSH_KEY" \
  "$LOCAL_PATH" "$SERVER_USER@$SERVER_HOST:$SERVER_PATH/"

echo "==> Rebuilding and restarting on the server..."
ssh -i "$SSH_KEY" "$SERVER_USER@$SERVER_HOST" "cd $SERVER_PATH && docker compose up --build -d"

echo "==> Applying any new database changes..."
ssh -i "$SSH_KEY" "$SERVER_USER@$SERVER_HOST" "cd $SERVER_PATH && docker compose exec -T server npx prisma migrate deploy --schema prisma/schema.prisma"

echo "==> Checking it's alive..."
ssh -i "$SSH_KEY" "$SERVER_USER@$SERVER_HOST" "curl -s -o /dev/null -w 'API responded with HTTP %{http_code}\n' -X POST http://localhost:8091/api/chat/message -H 'Content-Type: application/json' -d '{}'"

echo "==> Done. Live at http://$SERVER_HOST:8092"
