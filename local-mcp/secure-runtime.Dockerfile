FROM node:22-bookworm-slim

ARG MCP_PROXY_VERSION=0.1.8

RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates docker.io \
  && rm -rf /var/lib/apt/lists/* \
  && npm install --global "@srbhptl39/mcp-superassistant-proxy@${MCP_PROXY_VERSION}"

WORKDIR /opt/mcp-superassistant

COPY local-mcp/code-review-capability-gateway.mjs ./code-review-capability-gateway.mjs
COPY local-mcp/secure-runtime-entrypoint.sh ./secure-runtime-entrypoint.sh

RUN chmod 0755 ./secure-runtime-entrypoint.sh

EXPOSE 38106

ENTRYPOINT ["/opt/mcp-superassistant/secure-runtime-entrypoint.sh"]
