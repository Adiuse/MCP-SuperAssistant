#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG_PATH="${MCP_SUPERASSISTANT_CONFIG:-$HOME/.config/mcp-superassistant/config.json}"
GITHUB_ENV_PATH="${MCP_SUPERASSISTANT_GITHUB_ENV:-$HOME/.config/mcp-superassistant/github.env}"
HOST_BIND="${MCP_GATEWAY_HOST_BIND:-127.0.0.1}"
GATEWAY_PORT="${MCP_GATEWAY_PORT:-38106}"
IMAGE_TAG="${MCP_SECURE_RUNTIME_IMAGE:-mcp-superassistant-secure-runtime:prompt-bound}"
CONTAINER_NAME="${MCP_SECURE_RUNTIME_CONTAINER:-mcp-superassistant-secure-runtime}"

if [[ ! -f "$CONFIG_PATH" ]]; then
  echo "MCP config not found: $CONFIG_PATH" >&2
  exit 1
fi

if [[ ! -f "$GITHUB_ENV_PATH" ]]; then
  echo "GitHub credential file not found: $GITHUB_ENV_PATH" >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is required for the isolated secure Code Review runtime." >&2
  exit 1
fi

if [[ ! -S /var/run/docker.sock ]]; then
  echo "Docker socket not found: /var/run/docker.sock" >&2
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "Docker daemon is not available to the current user." >&2
  exit 1
fi

# A previous crashed run must never leave an old secure runtime behind.
docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true

echo "[secure-code-review] Building isolated secure runtime image (Docker cache will be reused)..."
docker build \
  --file "$ROOT_DIR/local-mcp/secure-runtime.Dockerfile" \
  --tag "$IMAGE_TAG" \
  "$ROOT_DIR"

echo "[secure-code-review] Publishing ONLY ${HOST_BIND}:${GATEWAY_PORT} -> capability gateway"
echo "[secure-code-review] PAT-bearing upstream remains on container loopback and has no host port."
echo "[secure-code-review] Extension Streamable HTTP URL: http://${HOST_BIND}:${GATEWAY_PORT}/mcp"

exec docker run \
  --rm \
  --name "$CONTAINER_NAME" \
  --publish "${HOST_BIND}:${GATEWAY_PORT}:38106" \
  --mount "type=bind,src=${CONFIG_PATH},dst=/run/config/config.json,readonly" \
  --mount "type=bind,src=${GITHUB_ENV_PATH},dst=/run/secrets/github.env,readonly" \
  --mount "type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock" \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  "$IMAGE_TAG"
