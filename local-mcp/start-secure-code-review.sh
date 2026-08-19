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

if ! grep -q '^GITHUB_PERSONAL_ACCESS_TOKEN=' "$GITHUB_ENV_PATH"; then
  echo "GITHUB_PERSONAL_ACCESS_TOKEN is not defined in: $GITHUB_ENV_PATH" >&2
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

CONFIG_BYTES="$(wc -c < "$CONFIG_PATH" | tr -d '[:space:]')"
if [[ ! "$CONFIG_BYTES" =~ ^[0-9]+$ ]] || (( CONFIG_BYTES <= 0 )); then
  echo "MCP config size could not be determined safely." >&2
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
echo "[secure-code-review] MCP config + GitHub credential are streamed into container tmpfs; neither is bind-mounted or passed in Docker args/env."
echo "[secure-code-review] Extension Streamable HTTP URL: http://${HOST_BIND}:${GATEWAY_PORT}/mcp"

# Stream config first (exact byte count), then the credential file. The bootstrap
# shell writes both into container-only tmpfs before starting the runtime. This
# avoids host-file ownership/mode problems after --cap-drop ALL while keeping the
# PAT out of docker inspect, command arguments, environment variables and logs.
{
  cat "$CONFIG_PATH"
  cat "$GITHUB_ENV_PATH"
} | exec docker run \
  --rm \
  --interactive \
  --name "$CONTAINER_NAME" \
  --publish "${HOST_BIND}:${GATEWAY_PORT}:38106" \
  --mount "type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock" \
  --tmpfs "/run/bootstrap:rw,noexec,nosuid,nodev,mode=0700" \
  --env "MCP_BOOTSTRAP_CONFIG_BYTES=${CONFIG_BYTES}" \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --entrypoint /bin/bash \
  "$IMAGE_TAG" \
  -lc 'set -euo pipefail; umask 077; dd iflag=fullblock bs=1 count="$MCP_BOOTSTRAP_CONFIG_BYTES" of=/run/bootstrap/config.json status=none; cat > /run/bootstrap/github.env; unset MCP_BOOTSTRAP_CONFIG_BYTES; exec /opt/mcp-superassistant/secure-runtime-entrypoint.sh'
