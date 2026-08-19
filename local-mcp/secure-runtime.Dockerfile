FROM node:22-bookworm-slim

ARG MCP_PROXY_VERSION=0.1.8
ARG DOCKER_CLI_VERSION=27.5.1
ARG TARGETARCH

RUN set -eux; \
  apt-get update; \
  apt-get install -y --no-install-recommends bash ca-certificates curl socat; \
  rm -rf /var/lib/apt/lists/*; \
  case "${TARGETARCH:-amd64}" in \
    amd64) docker_arch='x86_64' ;; \
    arm64) docker_arch='aarch64' ;; \
    *) echo "Unsupported Docker build architecture: ${TARGETARCH}" >&2; exit 1 ;; \
  esac; \
  curl -fsSL "https://download.docker.com/linux/static/stable/${docker_arch}/docker-${DOCKER_CLI_VERSION}.tgz" -o /tmp/docker.tgz; \
  tar -xzf /tmp/docker.tgz -C /tmp; \
  install -m 0755 /tmp/docker/docker /usr/local/bin/docker; \
  rm -rf /tmp/docker /tmp/docker.tgz; \
  docker --version; \
  npm install --global "@srbhptl39/mcp-superassistant-proxy@${MCP_PROXY_VERSION}"

WORKDIR /opt/mcp-superassistant

COPY local-mcp/code-review-capability-gateway.mjs ./code-review-capability-gateway.mjs
COPY local-mcp/secure-runtime-entrypoint.sh ./secure-runtime-entrypoint.sh

RUN chmod 0755 ./secure-runtime-entrypoint.sh

EXPOSE 38106

ENTRYPOINT ["/opt/mcp-superassistant/secure-runtime-entrypoint.sh"]
