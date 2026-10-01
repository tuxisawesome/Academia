#!/usr/bin/env bash
# Installs the development toolchain (uv and Node.js) into ~/.local without root,
# then installs the backend and frontend dependencies.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=../deploy/versions.env
. "$ROOT/deploy/versions.env"

mkdir -p "$HOME/.local/bin"

if ! command -v uv >/dev/null 2>&1 && [ ! -x "$HOME/.local/bin/uv" ]; then
  echo "Installing uv…"
  curl -LsSf "https://astral.sh/uv/${UV_VERSION}/install.sh" | env UV_NO_MODIFY_PATH=1 sh
fi

node_ok() {
  command -v node >/dev/null 2>&1 && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge "${NODE_MAJOR}" ]
}
if ! node_ok && [ ! -x "$HOME/.local/node/bin/node" ]; then
  case "$(uname -m)" in
    x86_64) arch=x64 ;;
    aarch64 | arm64) arch=arm64 ;;
    *) echo "Unsupported architecture: $(uname -m)" >&2; exit 1 ;;
  esac
  echo "Installing Node.js ${NODE_VERSION}…"
  tmp="$(mktemp -d)"
  curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${arch}.tar.xz" -o "$tmp/node.tar.xz"
  mkdir -p "$HOME/.local/node"
  tar -xJf "$tmp/node.tar.xz" -C "$HOME/.local/node" --strip-components=1
  rm -rf "$tmp"
fi

export PATH="$HOME/.local/bin:$HOME/.local/node/bin:$PATH"
(cd "$ROOT/backend" && uv sync)
(cd "$ROOT/frontend" && npm ci)

cat <<MSG

Done. Add this to your shell profile to use the tools directly:
  export PATH="\$HOME/.local/bin:\$HOME/.local/node/bin:\$PATH"

Then start Academia for development with:
  scripts/dev.sh
MSG
