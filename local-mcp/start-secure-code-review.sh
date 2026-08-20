#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GITHUB_ENV_PATH="${MCP_SUPERASSISTANT_GITHUB_ENV:-$HOME/.config/mcp-superassistant/github.env}"
HOST_BIND="127.0.0.1"
GATEWAY_PORT="38106"
IMAGE_TAG="${MCP_SECURE_RUNTIME_IMAGE:-mcp-superassistant-secure-runtime:prompt-bound}"
CONTAINER_NAME="${MCP_SECURE_RUNTIME_CONTAINER:-mcp-superassistant-secure-runtime}"

if [[ -n "${MCP_GATEWAY_HOST_BIND:-}" && "${MCP_GATEWAY_HOST_BIND}" != "$HOST_BIND" ]]; then
  echo "MCP_GATEWAY_HOST_BIND is security-fixed to 127.0.0.1." >&2
  exit 1
fi

if [[ -n "${MCP_GATEWAY_PORT:-}" && "${MCP_GATEWAY_PORT}" != "$GATEWAY_PORT" ]]; then
  echo "MCP_GATEWAY_PORT is security-fixed to 38106." >&2
  exit 1
fi

if [[ ! -f "$GITHUB_ENV_PATH" ]]; then
  echo "GitHub credential file not found: $GITHUB_ENV_PATH" >&2
  exit 1
fi

if ! grep -q '^GITHUB_PERSONAL_ACCESS_TOKEN=' "$GITHUB_ENV_PATH"; then
  echo "GITHUB_PERSONAL_ACCESS_TOKEN is not defined in: $GITHUB_ENV_PATH" >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is required to start the isolated Code Review runtime." >&2
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "Docker daemon is not available to the current user." >&2
  exit 1
fi

# A previous crashed run must never leave an old runtime behind.
docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true

echo "[secure-code-review] Building isolated secure runtime image (Docker cache will be reused)..."
docker build \
  --file "$ROOT_DIR/local-mcp/secure-runtime.Dockerfile" \
  --tag "$IMAGE_TAG" \
  "$ROOT_DIR"

echo "[secure-code-review] Publishing ONLY 127.0.0.1:38106 -> capability gateway"
echo "[secure-code-review] GitHub MCP runs in-process without a Docker socket or host control path."
echo "[secure-code-review] The PAT is streamed to container tmpfs; it is not a Docker arg/env or bind mount."
echo "[secure-code-review] Extension URL: http://127.0.0.1:38106/mcp (Streamable HTTP)"

cat "$GITHUB_ENV_PATH" | exec docker run \
  --rm \
  --interactive \
  --name "$CONTAINER_NAME" \
  --publish "127.0.0.1:38106:38106" \
  --read-only \
  --tmpfs "/run/bootstrap:rw,noexec,nosuid,nodev,mode=0700,uid=10001,gid=10001" \
  --tmpfs "/tmp:rw,noexec,nosuid,nodev,mode=0700,uid=10001,gid=10001" \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  "$IMAGE_TAG"
