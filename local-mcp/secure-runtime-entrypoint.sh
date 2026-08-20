#!/usr/bin/env bash
set -euo pipefail

CONFIG_PATH="/opt/mcp-superassistant/config.json"
GITHUB_ENV_PATH="/run/bootstrap/github.env"
PUBLIC_PORT="38106"
GATEWAY_INTERNAL_PORT="38108"
UPSTREAM_HOST="127.0.0.1"
UPSTREAM_PORT="38107"
UPSTREAM_URL="http://${UPSTREAM_HOST}:${UPSTREAM_PORT}/mcp"

if [[ ! -r "$CONFIG_PATH" ]]; then
  echo "Immutable MCP config is missing inside secure runtime: $CONFIG_PATH" >&2
  exit 1
fi

umask 077
cat > "$GITHUB_ENV_PATH"
if ! grep -q '^GITHUB_PERSONAL_ACCESS_TOKEN=' "$GITHUB_ENV_PATH"; then
  echo "GITHUB_PERSONAL_ACCESS_TOKEN was not provided to the secure runtime." >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$GITHUB_ENV_PATH"
set +a

if [[ -z "${GITHUB_PERSONAL_ACCESS_TOKEN:-}" ]]; then
  echo "GITHUB_PERSONAL_ACCESS_TOKEN is empty." >&2
  exit 1
fi

if ! command -v github-mcp-server >/dev/null 2>&1; then
  echo "Official github-mcp-server binary is not installed in secure runtime." >&2
  exit 1
fi

if command -v docker >/dev/null 2>&1 || [[ -S /var/run/docker.sock ]]; then
  echo "Secure runtime invariant failed: Docker access must not exist inside the container." >&2
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

echo "[secure-code-review] Starting PAT-bearing MCP proxy on ${UPSTREAM_HOST}:${UPSTREAM_PORT}"
mcp-superassistant-proxy \
  --config "$CONFIG_PATH" \
  --outputTransport streamableHttp \
  --stateful \
  --host "$UPSTREAM_HOST" \
  --port "$UPSTREAM_PORT" &
PROXY_PID=$!

sleep 1
if ! kill -0 "$PROXY_PID" 2>/dev/null; then
  echo "PAT-bearing MCP proxy exited before the capability gateway could start." >&2
  exit 1
fi

echo "[secure-code-review] Starting capability gateway on 127.0.0.1:${GATEWAY_INTERNAL_PORT}"
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

echo "[secure-code-review] Exposing only the gated front door on container port ${PUBLIC_PORT}"
socat \
  "TCP-LISTEN:${PUBLIC_PORT},fork,reuseaddr,bind=0.0.0.0" \
  "TCP:127.0.0.1:${GATEWAY_INTERNAL_PORT}" &
SOCAT_PID=$!

sleep 0.25
if ! kill -0 "$SOCAT_PID" 2>/dev/null; then
  echo "Secure front-door forwarder failed to start." >&2
  exit 1
fi

wait -n "$SOCAT_PID" "$GATEWAY_PID" "$PROXY_PID"
echo "[secure-code-review] A required runtime process exited; shutting down fail-closed." >&2
exit 1
