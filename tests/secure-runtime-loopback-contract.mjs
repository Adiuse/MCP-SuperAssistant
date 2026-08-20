import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');
const [launcher, entrypoint, gatewaySource, ssot] = await Promise.all([
  fs.readFile(path.join(repoRoot, 'local-mcp', 'start-secure-code-review.sh'), 'utf8'),
  fs.readFile(path.join(repoRoot, 'local-mcp', 'secure-runtime-entrypoint.sh'), 'utf8'),
  fs.readFile(path.join(repoRoot, 'local-mcp', 'code-review-capability-gateway.mjs'), 'utf8'),
  fs.readFile(path.join(repoRoot, 'docs', 'SSOT_PROMPT_BOUND_GITHUB_ACCESS_GATEWAY.md'), 'utf8'),
]);

assert.match(launcher, /HOST_BIND="127\.0\.0\.1"/);
assert.match(launcher, /GATEWAY_PORT="38106"/);
assert.match(launcher, /--publish "127\.0\.0\.1:38106:38106"/);
assert.match(launcher, /MCP_GATEWAY_HOST_BIND is security-fixed to 127\.0\.0\.1/);
assert.doesNotMatch(launcher, /--publish "\$\{HOST_BIND\}:\$\{GATEWAY_PORT\}/);

assert.match(entrypoint, /UPSTREAM_HOST="127\.0\.0\.1"/);
assert.match(entrypoint, /UPSTREAM_PORT="38107"/);
assert.match(entrypoint, /GATEWAY_INTERNAL_PORT="38108"/);
assert.match(entrypoint, /--host "\$UPSTREAM_HOST"[\s\S]*--port "\$UPSTREAM_PORT"/);
assert.match(entrypoint, /MCP_GATEWAY_HOST="127\.0\.0\.1"/);
assert.match(entrypoint, /TCP-LISTEN:\$\{PUBLIC_PORT\}.*TCP:127\.0\.0\.1:\$\{GATEWAY_INTERNAL_PORT\}/s);
assert.doesNotMatch(entrypoint, /http:\/\/localhost/);

assert.match(gatewaySource, /const DEFAULT_HOST = '127\.0\.0\.1'/);
assert.match(gatewaySource, /MCP_GATEWAY_HOST is security-fixed to 127\.0\.0\.1/);
assert.match(gatewaySource, /http:\/\/127\.0\.0\.1:38107\/mcp/);
assert.doesNotMatch(gatewaySource, /http:\/\/localhost:38107\/mcp/);
assert.match(ssot, /Endpoint رسمی و Canonical روی Host:[\s\S]*http:\/\/127\.0\.0\.1:38106\/mcp/);

console.log(
  '✓ Host/front-door, internal gateway and PAT proxy bindings are explicit IPv4 loopback and non-overridable',
);
