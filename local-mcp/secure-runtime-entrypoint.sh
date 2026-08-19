#!/usr/bin/env bash
set -euo pipefail

CONFIG_PATH="${MCP_SUPERASSISTANT_CONFIG:-/run/config/config.json}"
GITHUB_ENV_PATH="${MCP_SUPERASSISTANT_GITHUB_ENV:-/run/secrets/github.env}"
PUBLIC_PORT="${MCP_GATEWAY_PUBLIC_PORT:-38106}"
GATEWAY_INTERNAL_PORT="${MCP_GATEWAY_INTERNAL_PORT:-38108}"
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

if ! command -v socat >/dev/null 2>&1; then
  echo "socat is not available inside secure runtime." >&2
  exit 1
fi

cleanup() {
  for pid in "${SOCAT_PID:-}" "${GATEWAY_PID:-}" "${PROXY_PID:-}"; do
    if [[ -n "$pid" ]]; then
      kill "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
    fi
  done
}
trap cleanup EXIT INT TERM

echo "[secure-code-review] Starting PAT-bearing MCP proxy on container-localhost:${UPSTREAM_PORT}"
echo "[secure-code-review] The PAT-bearing proxy port is NOT published to the host."
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

echo "[secure-code-review] Starting capability gateway on container loopback 127.0.0.1:${GATEWAY_INTERNAL_PORT}"
MCP_GATEWAY_HOST="127.0.0.1" \
MCP_GATEWAY_PORT="$GATEWAY_INTERNAL_PORT" \
MCP_UPSTREAM_URL="$UPSTREAM_URL" \
  node /opt/mcp-superassistant/code-review-capability-gateway.mjs &
GATEWAY_PID=$!

sleep 1
if ! kill -0 "$GATEWAY_PID" 2>/dev/null; then
  echo "Capability gateway exited before the host front door could start." >&2
  exit 1
fi

echo "[secure-code-review] Exposing only the capability-gated front door on container port ${PUBLIC_PORT}"
socat \
  "TCP-LISTEN:${PUBLIC_PORT},fork,reuseaddr,bind=0.0.0.0" \
  "TCP:127.0.0.1:${GATEWAY_INTERNAL_PORT}" &
SOCAT_PID=$!

sleep 0.25
if ! kill -0 "$SOCAT_PID" 2>/dev/null; then
  echo "Secure front-door forwarder failed to start." >&2
  exit 1
fi

echo "[secure-code-review] Secure runtime ready. Only the capability gateway is published."
wait -n "$PROXY_PID" "$GATEWAY_PID" "$SOCAT_PID"
