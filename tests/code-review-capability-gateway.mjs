import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const gatewayPath = path.join(__dirname, '..', 'local-mcp', 'code-review-capability-gateway.mjs');
const gateway = await import(`${pathToFileURL(gatewayPath).href}?t=${Date.now()}`);

const DEVICE = 'a'.repeat(64);
const state = gateway.createGatewayState();
const now = Date.now();

const lease = gateway.registerLease(state, DEVICE, {
  sessionId: 'session-a',
  capabilityId: 'cap-a',
  jobId: 'job-a',
  userTurnId: 'turn-a',
  owner: 'Adiuse',
  repo: 'shaahane-monorepo',
  originTabId: 42,
  sourcePath: '/c/review-a',
  expiresAt: now + 20 * 60_000,
  readOnly: true,
  allowedTools: [...gateway.ALLOWED_TOOLS],
});
assert.equal(lease.jobId, 'job-a');

const read = gateway.authorizeToolCall(state, DEVICE, {
  method: 'tools/call',
  params: {
    name: 'github-review.get_file_contents',
    arguments: { owner: 'Adiuse', repo: 'shaahane-monorepo', path: 'apps/api/src/a.ts' },
  },
}, now);
assert.equal(read.ok, true);
assert.equal(read.lease.userTurnId, 'turn-a');

const search = gateway.authorizeToolCall(state, DEVICE, {
  method: 'tools/call',
  params: {
    name: 'github-review.search_code',
    arguments: { query: 'PaymentService repo:Adiuse/shaahane-monorepo' },
  },
}, now);
assert.equal(search.ok, true);

assert.equal(gateway.authorizeToolCall(state, '', {
  method: 'tools/call',
  params: { name: 'github-review.get_file_contents', arguments: { owner: 'Adiuse', repo: 'shaahane-monorepo' } },
}, now).ok, false, 'PAT/upstream access without the extension device credential must fail');

assert.equal(gateway.authorizeToolCall(state, 'b'.repeat(64), {
  method: 'tools/call',
  params: { name: 'github-review.get_file_contents', arguments: { owner: 'Adiuse', repo: 'shaahane-monorepo' } },
}, now).ok, false, 'an unregistered device must not borrow another device lease');

assert.equal(gateway.authorizeToolCall(state, DEVICE, {
  method: 'tools/call',
  params: { name: 'github-review.get_file_contents', arguments: { owner: 'Adiuse', repo: 'MCP-SuperAssistant', path: 'README.md' } },
}, now).ok, false, 'repo escape must fail at the gateway too');

assert.equal(gateway.authorizeToolCall(state, DEVICE, {
  method: 'tools/call',
  params: { name: 'github-review.search_code', arguments: { query: 'secret repo:Adiuse/MCP-SuperAssistant' } },
}, now).ok, false, 'search qualifier escape must fail at the gateway too');

assert.equal(gateway.authorizeToolCall(state, DEVICE, {
  method: 'tools/call',
  params: { name: 'github-review.create_file', arguments: { owner: 'Adiuse', repo: 'shaahane-monorepo' } },
}, now).ok, false, 'write tools must fail at the gateway too');

assert.equal(gateway.revokeLease(state, DEVICE, 'session-a'), true);
assert.equal(gateway.authorizeToolCall(state, DEVICE, {
  method: 'tools/call',
  params: { name: 'github-review.get_me', arguments: {} },
}, now).ok, false, 'revoke must close the proxy gate immediately');

gateway.registerLease(state, DEVICE, {
  sessionId: 'session-expiring',
  capabilityId: 'cap-expiring',
  jobId: 'job-expiring',
  userTurnId: 'turn-expiring',
  owner: 'Adiuse',
  repo: 'shaahane-monorepo',
  originTabId: 42,
  sourcePath: '/c/review-a',
  expiresAt: now + 1_000,
  readOnly: true,
  allowedTools: [...gateway.ALLOWED_TOOLS],
});
assert.equal(gateway.authorizeToolCall(state, DEVICE, {
  method: 'tools/call',
  params: { name: 'github-review.get_me', arguments: {} },
}, now + 2_000).ok, false, 'expiry must be enforced independently by the gateway clock');

console.log('✓ Capability gateway requires an extension credential + active prompt-bound lease and re-enforces read-only repo scope');
