import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');
const gatewayPath = path.join(repoRoot, 'local-mcp', 'code-review-capability-gateway.mjs');
const gateway = await import(`${pathToFileURL(gatewayPath).href}?t=${Date.now()}`);
const [launcher, dockerfile, entrypoint, config] = await Promise.all([
  fs.readFile(path.join(repoRoot, 'local-mcp', 'start-secure-code-review.sh'), 'utf8'),
  fs.readFile(path.join(repoRoot, 'local-mcp', 'secure-runtime.Dockerfile'), 'utf8'),
  fs.readFile(path.join(repoRoot, 'local-mcp', 'secure-runtime-entrypoint.sh'), 'utf8'),
  fs.readFile(path.join(repoRoot, 'local-mcp', 'config.json'), 'utf8'),
]);

const DEVICE = 'a'.repeat(64);
const TOKEN = 'c'.repeat(64);
const now = Date.now();

function leasePayload(overrides = {}) {
  return {
    sessionId: 'session-a',
    capabilityId: 'cap-a',
    capabilityToken: TOKEN,
    jobId: 'job-a',
    userTurnId: 'turn-a',
    owner: 'Adiuse',
    repo: 'shaahane-monorepo',
    originTabId: 42,
    sourcePath: '/c/review-a',
    expiresAt: now + 20 * 60_000,
    readOnly: true,
    serverId: gateway.CODE_REVIEW_SERVER_ID,
    allowedTools: [...gateway.ALLOWED_TOOLS],
    ...overrides,
  };
}

function envelope(overrides = {}) {
  return {
    sessionId: 'session-a',
    capabilityId: 'cap-a',
    capabilityToken: TOKEN,
    jobId: 'job-a',
    userTurnId: 'turn-a',
    originTabId: 42,
    sourcePath: '/c/review-a',
    serverId: gateway.CODE_REVIEW_SERVER_ID,
    ...overrides,
  };
}

function toolRequest(name, args = {}, bindingOverrides = {}) {
  return {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name,
      arguments: {
        ...args,
        [gateway.CAPABILITY_ARGUMENT]: envelope(bindingOverrides),
      },
    },
  };
}

const state = gateway.createGatewayState();
const lease = gateway.registerLease(state, DEVICE, leasePayload());
const read = gateway.authorizeToolCall(
  state,
  DEVICE,
  toolRequest('github-review__get_file_contents', {
    owner: 'Adiuse',
    repo: 'shaahane-monorepo',
    path: 'apps/api/src/a.ts',
  }),
  now,
);
assert.equal(read.ok, true);
assert.equal(read.lease.userTurnId, 'turn-a');
assert.equal(
  read.request.params.arguments[gateway.CAPABILITY_ARGUMENT],
  undefined,
  'capability must be stripped before upstream',
);

for (const [field, badValue] of [
  ['sessionId', 'session-b'],
  ['capabilityId', 'cap-b'],
  ['capabilityToken', 'd'.repeat(64)],
  ['jobId', 'job-b'],
  ['userTurnId', 'turn-b'],
  ['originTabId', 43],
  ['sourcePath', '/c/review-b'],
  ['serverId', 'other-server'],
]) {
  const denied = gateway.authorizeToolCall(state, DEVICE, toolRequest('get_me', {}, { [field]: badValue }), now);
  assert.equal(denied.ok, false, `${field} mismatch must deny`);
}

assert.equal(
  gateway.authorizeToolCall(
    state,
    DEVICE,
    {
      method: 'tools/call',
      params: { name: 'get_me', arguments: {} },
    },
    now,
  ).ok,
  false,
  'device credential without a per-call capability must deny',
);
assert.equal(
  gateway.authorizeToolCall(
    state,
    DEVICE,
    toolRequest('filesystem__get_file_contents', { owner: 'Adiuse', repo: 'shaahane-monorepo' }),
    now,
  ).ok,
  false,
  'a same-suffix tool from another MCP server must not gain GitHub provenance',
);
assert.equal(
  gateway.authorizeToolCall(
    state,
    DEVICE,
    toolRequest('get_file_contents', { owner: 'Adiuse', repo: 'MCP-SuperAssistant', path: 'README.md' }),
    now,
  ).ok,
  false,
  'repo escape must deny',
);

for (const query of [
  'secret repo:Adiuse/MCP-SuperAssistant',
  'PaymentService repo:Adiuse/shaahane-monorepo OR secret',
  'PaymentService NOT secret repo:Adiuse/shaahane-monorepo',
  'PaymentService repo:Adiuse/shaahane-monorepo trailing',
]) {
  assert.equal(
    gateway.authorizeToolCall(state, DEVICE, toolRequest('search_code', { query }), now).ok,
    false,
    `search escape must deny: ${query}`,
  );
}
assert.equal(
  gateway.authorizeToolCall(
    state,
    DEVICE,
    toolRequest('search_code', { query: 'PaymentService repo:Adiuse/shaahane-monorepo' }),
    now,
  ).ok,
  true,
);

let upstreamCalls = 0;
let lastUpstreamRpc = null;
const upstream = http.createServer(async (req, res) => {
  upstreamCalls += 1;
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString('utf8');
  lastUpstreamRpc = body ? JSON.parse(body) : null;
  const requestedPath = lastUpstreamRpc?.params?.arguments?.path;
  const response =
    requestedPath === 'oversized'
      ? Buffer.alloc(gateway.MAX_SINGLE_RESPONSE_BYTES + 1, 120)
      : Buffer.from(
          JSON.stringify({
            jsonrpc: '2.0',
            id: lastUpstreamRpc?.id,
            result: { content: [{ type: 'text', text: '# ok' }] },
          }),
        );
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(response);
});
await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
const upstreamPort = upstream.address().port;

const httpState = gateway.createGatewayState();
const httpLease = gateway.registerLease(httpState, DEVICE, leasePayload());
const server = gateway.createCapabilityGatewayServer({
  state: httpState,
  upstreamUrl: `http://127.0.0.1:${upstreamPort}/mcp`,
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const gatewayPort = server.address().port;
const endpoint = `http://127.0.0.1:${gatewayPort}/mcp`;

async function rpcFetch(rpc, device = DEVICE) {
  return fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-mcp-superassistant-device': device },
    body: JSON.stringify(rpc),
  });
}

let response = await rpcFetch({ jsonrpc: '2.0', id: 1, method: 'resources/read', params: { uri: 'repo://secret' } });
assert.equal(response.status, 403);
assert.equal(upstreamCalls, 0, 'resource/custom MCP methods must be denied before upstream');

response = await rpcFetch({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_me', arguments: {} } });
assert.equal(response.status, 403);
assert.equal(upstreamCalls, 0, 'tools/call without per-call lease must be denied before upstream');

response = await rpcFetch(
  toolRequest('github-review__get_file_contents', {
    owner: 'Adiuse',
    repo: 'shaahane-monorepo',
    path: 'README.md',
  }),
);
assert.equal(response.status, 200);
assert.equal(upstreamCalls, 1);
assert.equal(lastUpstreamRpc.params.arguments[gateway.CAPABILITY_ARGUMENT], undefined);

response = await rpcFetch(
  toolRequest('get_file_contents', {
    owner: 'Adiuse',
    repo: 'shaahane-monorepo',
    path: 'oversized',
  }),
);
assert.equal(response.status, 413, 'single responses above 2 MB must be denied by the gateway');

httpLease.responseBytes = gateway.MAX_LEASE_RESPONSE_BYTES - 1;
response = await rpcFetch(toolRequest('get_me'));
assert.equal(response.status, 413, 'lease response total above 25 MB must revoke at the gateway');
assert.equal(httpState.devices.get(DEVICE).leases.has('session-a'), false);

const limitState = gateway.createGatewayState();
const limitLease = gateway.registerLease(limitState, DEVICE, leasePayload({ sessionId: 'limit-session' }));
limitLease.callCount = gateway.MAX_TOOL_CALLS;
const limitRequest = toolRequest('get_me', {}, { sessionId: 'limit-session' });
assert.equal(gateway.authorizeToolCall(limitState, DEVICE, limitRequest, now).status, 429);
assert.equal(limitState.devices.get(DEVICE).leases.has('limit-session'), false);

await new Promise(resolve => server.close(resolve));
await new Promise(resolve => upstream.close(resolve));

assert.match(launcher, /HOST_BIND="127\.0\.0\.1"/);
assert.match(launcher, /GATEWAY_PORT="38106"/);
assert.match(launcher, /--publish "127\.0\.0\.1:38106:38106"/);
assert.match(launcher, /--read-only/);
assert.doesNotMatch(launcher, /--mount[^\n]*docker\.sock|src=\/var\/run\/docker\.sock/);
assert.doesNotMatch(launcher, /MCP_BOOTSTRAP_CONFIG_BYTES|cat "\$CONFIG_PATH"/);
assert.doesNotMatch(launcher, /--env(?:-file)?[^\n]*GITHUB/);

assert.match(dockerfile, /COPY --from=github-mcp \/server\/github-mcp-server \/usr\/local\/bin\/github-mcp-server/);
assert.match(dockerfile, /USER 10001:10001/);
assert.doesNotMatch(dockerfile, /docker-(?:cli|[0-9])|\/usr\/local\/bin\/docker/);
assert.match(entrypoint, /CONFIG_PATH="\/opt\/mcp-superassistant\/config\.json"/);
assert.match(entrypoint, /command -v docker[\s\S]*\/var\/run\/docker\.sock/);
assert.doesNotMatch(entrypoint, /docker run|docker inspect/);
assert.match(config, /"command": "\/usr\/local\/bin\/github-mcp-server"/);
assert.doesNotMatch(config, /"command": "docker"|ghcr\.io\/github\/github-mcp-server/);

console.log(
  '✓ Gateway requires exact per-call Repo + UserTurn + Origin + Time capability and strips it before upstream',
);
console.log('✓ Search/provenance/custom-method escapes and gateway-side abuse ceilings fail closed');
console.log(
  '✓ Runtime has immutable GitHub MCP provenance, no Docker socket/CLI, and no PAT in Docker inspect configuration',
);
