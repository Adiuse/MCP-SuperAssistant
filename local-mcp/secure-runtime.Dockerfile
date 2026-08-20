ARG GITHUB_MCP_IMAGE=ghcr.io/github/github-mcp-server:latest
FROM ${GITHUB_MCP_IMAGE} AS github-mcp

FROM node:22-bookworm-slim

ARG MCP_PROXY_VERSION=0.1.8

RUN set -eux; \
  apt-get update; \
  apt-get install -y --no-install-recommends bash ca-certificates socat; \
  rm -rf /var/lib/apt/lists/*; \
  npm install --global "@srbhptl39/mcp-superassistant-proxy@${MCP_PROXY_VERSION}"; \
  groupadd --gid 10001 mcp-runtime; \
  useradd --uid 10001 --gid 10001 --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin mcp-runtime

# Run the official GitHub MCP binary directly in this container. The secure
# runtime therefore has no Docker CLI/socket and cannot create host containers.
COPY --from=github-mcp /server/github-mcp-server /usr/local/bin/github-mcp-server

WORKDIR /opt/mcp-superassistant

COPY local-mcp/code-review-capability-gateway.mjs ./code-review-capability-gateway.mjs
COPY local-mcp/secure-runtime-entrypoint.sh ./secure-runtime-entrypoint.sh
COPY local-mcp/config.json ./config.json

RUN chmod 0555 /usr/local/bin/github-mcp-server ./secure-runtime-entrypoint.sh \
  && chmod 0444 ./code-review-capability-gateway.mjs ./config.json

USER 10001:10001

EXPOSE 38106

ENTRYPOINT ["/opt/mcp-superassistant/secure-runtime-entrypoint.sh"]
