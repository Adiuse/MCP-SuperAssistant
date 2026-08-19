import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');
const entrypoint = await fs.readFile(path.join(repoRoot, 'local-mcp', 'secure-runtime-entrypoint.sh'), 'utf8');
const ssot = await fs.readFile(path.join(repoRoot, 'docs', 'SSOT_PROMPT_BOUND_GITHUB_ACCESS_GATEWAY.md'), 'utf8');

assert.match(
  entrypoint,
  /UPSTREAM_HOST="\$\{MCP_UPSTREAM_HOST:-127\.0\.0\.1\}"/,
  'PAT-bearing MCP proxy must default to explicit IPv4 loopback inside the secure runtime',
);
assert.match(
  entrypoint,
  /UPSTREAM_URL="\$\{MCP_UPSTREAM_URL:-http:\/\/\$\{UPSTREAM_HOST\}:\$\{UPSTREAM_PORT\}\/mcp\}"/,
  'capability gateway upstream must be derived from the explicit loopback host',
);
assert.match(
  entrypoint,
  /--host "\$UPSTREAM_HOST"[\s\S]*--port "\$UPSTREAM_PORT"/,
  'mcp-superassistant-proxy must receive an explicit --host instead of relying on localhost resolution',
);
assert.doesNotMatch(
  entrypoint,
  /http:\/\/localhost:38107\/mcp/,
  'secure runtime must not use ambiguous localhost for the PAT-bearing upstream path',
);
assert.match(
  ssot,
  /Endpoint رسمی و Canonical روی Host:[\s\S]*http:\/\/127\.0\.0\.1:38106\/mcp/,
  'SSOT must retain the explicit host front-door endpoint',
);

console.log('✓ Secure runtime binds both the host front door and internal PAT-bearing MCP proxy to explicit IPv4 loopback');
