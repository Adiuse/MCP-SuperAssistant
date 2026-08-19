#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG_PATH="${MCP_SUPERASSISTANT_CONFIG:-$HOME/.config/mcp-superassistant/config.json}"
GITHUB_ENV_PATH="${MCP_SUPERASSISTANT_GITHUB_ENV:-$HOME/.config/mcp-superassistant/github.env}"
GATEWAY_HOST="${MCP_GATEWAY_HOST:-localhost}"
GATEWAY_PORT="${MCP_GATEWAY_PORT:-38106}"
UPSTREAM_PORT="${MCP_UPSTREAM_PORT:-38107}"
UPSTREAM_URL="${MCP_UPSTREAM_URL:-http://localhost:${UPSTREAM_PORT}/mcp}"

if [[ ! -f "$CONFIG_PATH" ]]; then
  echo "MCP config not found: $CONFIG_PATH" >&2
  exit 1
fi

if [[ -f "$GITHUB_ENV_PATH" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$GITHUB_ENV_PATH"
  set +a
fi

if [[ -z "${GITHUB_PERSONAL_ACCESS_TOKEN:-}" ]]; then
  echo "GITHUB_PERSONAL_ACCESS_TOKEN is not exported. Set it in: $GITHUB_ENV_PATH" >&2
  exit 1
fi

cleanup() {
  if [[ -n "${PROXY_PID:-}" ]]; then
    kill "$PROXY_PID" 2>/dev/null || true
    wait "$PROXY_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

echo "[secure-code-review] Starting upstream MCP proxy on port $UPSTREAM_PORT"
npm exec @srbhptl39/mcp-superassistant-proxy@latest -- \
  --config "$CONFIG_PATH" \
  --outputTransport streamableHttp \
  --stateful \
  --port "$UPSTREAM_PORT" &
PROXY_PID=$!

# Give the upstream process a moment to bind before exposing the front door.
sleep 1
if ! kill -0 "$PROXY_PID" 2>/dev/null; then
  echo "Upstream MCP proxy exited before the secure gateway could start." >&2
  exit 1
fi

echo "[secure-code-review] Starting capability gateway on http://${GATEWAY_HOST}:${GATEWAY_PORT}/mcp"
echo "[secure-code-review] Keep the extension MCP URL pointed at http://localhost:${GATEWAY_PORT}/mcp"
MCP_GATEWAY_HOST="$GATEWAY_HOST" \
MCP_GATEWAY_PORT="$GATEWAY_PORT" \
MCP_UPSTREAM_URL="$UPSTREAM_URL" \
  node "$ROOT_DIR/local-mcp/code-review-capability-gateway.mjs"
