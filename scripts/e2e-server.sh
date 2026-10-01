#!/usr/bin/env bash
# Starts a throwaway Academia server for the Playwright tests (see frontend/playwright.config.ts).
# The frontend must be built first:  (cd frontend && npm run build)
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PATH="$HOME/.local/bin:$HOME/.local/node/bin:$PATH"
: "${E2E_DIR:?E2E_DIR must be set}"
export ACADEMIA_DATA_DIR="$E2E_DIR/data"
rm -rf "$ACADEMIA_DATA_DIR"
cd "$ROOT/backend"
uv run python "$ROOT/scripts/make-fixtures.py" "$E2E_DIR/fixtures" >/dev/null
uv run academia migrate >/dev/null 2>&1
uv run academia create-user e2e --admin --password e2e-password-123 --no-force-change >/dev/null
exec uv run uvicorn --factory academia.main:create_app --host 127.0.0.1 --port "${E2E_PORT:-8766}" --log-level warning
