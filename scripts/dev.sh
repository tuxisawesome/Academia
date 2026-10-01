#!/usr/bin/env bash
# Runs the backend (auto-reload) and the Vite dev server together.
#   Backend:  http://127.0.0.1:8000   Frontend: http://localhost:5173 (use this one)
# Set ACADEMIA_DEV_PORT to run the backend on another port.
# On first run a user "admin" with password "academia-dev" is created.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PATH="$HOME/.local/bin:$HOME/.local/node/bin:$PATH"
export ACADEMIA_DATA_DIR="${ACADEMIA_DATA_DIR:-$ROOT/data}"
PORT="${ACADEMIA_DEV_PORT:-8000}"
export ACADEMIA_BACKEND="http://127.0.0.1:$PORT"

command -v uv >/dev/null || { echo "uv not found — run scripts/dev-bootstrap.sh first." >&2; exit 1; }
command -v npm >/dev/null || { echo "npm not found — run scripts/dev-bootstrap.sh first." >&2; exit 1; }

cd "$ROOT/backend"
uv run academia migrate >/dev/null
uv run academia create-user admin --admin --password academia-dev --no-force-change --if-no-users

trap 'kill 0' EXIT INT TERM
uv run uvicorn --factory academia.main:create_app --host 127.0.0.1 --port "$PORT" --reload --reload-dir academia &
(cd "$ROOT/frontend" && npm run dev -- --host 127.0.0.1) &
wait
