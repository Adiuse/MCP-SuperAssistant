#!/usr/bin/env bash
set -euo pipefail

CONFIG_PATH="${MCP_SUPERASSISTANT_CONFIG:-/run/config/config.json}"
GITHUB_ENV_PATH="${MCP_SUPERASSISTANT_GITHUB_ENV:-/run/secrets/github.env}"
GATEWAY_HOST="${MCP_GATEWAY_HOST:-0.0.0.0}"
GATEWAY_PORT="${MCP_GATEWAY_PORT:-38106}"
UPSTREAM_PORT="${MCP_UPSTREAM_PORT:-38107}"
UPSTREAM_URL="${MCP_UPSTREAM_URL:-http://localhost:${UPSTREAM_PORT}/mcp}"

if [[ ! -f "$CONFIG_PATH" ]]; then
  echo "MCP config not found inside secure runtime: $CONFIG_PATH" >&2
  exit 1
fi

if [[ ! -f "$GITHUB_ENV_PATH" ]]; then
  echo "GitHub credential file not found inside secure runtime: $GITHUB_ENV_PATH" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$GITHUB_ENV_PATH"
set +a

if [[ -z "${GITHUB_PERSONAL_ACCESS_TOKEN:-}" ]]; then
  echo "GITHUB_PERSONAL_ACCESS_TOKEN is not exported by: $GITHUB_ENV_PATH" >&2
  exit 1
fi

if [[ ! -S /var/run/docker.sock ]]; then
  echo "Docker socket is required so the configured github-review stdio server can be launched." >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "docker CLI is not available inside secure runtime." >&2
  exit 1
fi

if ! command -v mcp-superassistant-proxy >/dev/null 2>&1; then
  echo "mcp-superassistant-proxy binary is not installed in secure runtime." >&2
  exit 1
fi

cleanup() {
  if [[ -n "${PROXY_PID:-}" ]]; then
    kill "$PROXY_PID" 2>/dev/null || true
    wait "$PROXY_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

echo "[secure-code-review] Starting PAT-bearing MCP proxy on container-loopback:${UPSTREAM_PORT}"
echo "[secure-code-review] The upstream proxy port is NOT published to the host."
mcp-superassistant-proxy \
  --config "$CONFIG_PATH" \
  --outputTransport streamableHttp \
  --stateful \
  --port "$UPSTREAM_PORT" &
PROXY_PID=$!

sleep 1
if ! kill -0 "$PROXY_PID" 2>/dev/null; then
  echo "PAT-bearing MCP proxy exited before the capability gateway could start." >&2
  exit 1
fi

echo "[secure-code-review] Starting capability gateway on ${GATEWAY_HOST}:${GATEWAY_PORT}"
MCP_GATEWAY_HOST="$GATEWAY_HOST" \
MCP_GATEWAY_PORT="$GATEWAY_PORT" \
MCP_UPSTREAM_URL="$UPSTREAM_URL" \
MCP_GATEWAY_CONTAINERIZED=1 \
  node /opt/mcp-superassistant/code-review-capability-gateway.mjs
