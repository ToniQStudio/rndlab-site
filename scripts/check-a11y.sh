#!/usr/bin/env bash
# Поднимает статический сервер на 8080, гоняет pa11y-ci и гасит сервер.
set -euo pipefail

cd "$(dirname "$0")/.."

PORT=8080
python3 -m http.server "$PORT" >/dev/null 2>&1 &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null || true' EXIT

for _ in $(seq 1 30); do
  if curl -sf "http://127.0.0.1:$PORT/" >/dev/null; then
    break
  fi
  sleep 1
done

npx --yes pa11y-ci@5 --config .pa11yci.json
