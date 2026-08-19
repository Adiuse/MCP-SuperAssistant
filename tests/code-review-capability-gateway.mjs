import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');
const gatewayPath = path.join(repoRoot, 'local-mcp', 'code-review-capability-gateway.mjs');
const launcherPath = path.join(repoRoot, 'local-mcp', 'start-secure-code-review.sh');
const dockerfilePath = path.join(repoRoot, 'local-mcp', 'secure-runtime.Dockerfile');
const entrypointPath = path.join(repoRoot, 'local-mcp', 'secure-runtime-entrypoint.sh');
const gateway = await import(`${pathToFileURL(gatewayPath).href}?t=${Date.now()}`);
const [launcher, dockerfile, entrypoint] = await Promise.all([
  fs.readFile(launcherPath, 'utf8'),
  fs.readFile(dockerfilePath, 'utf8'),
  fs.readFile(entrypointPath, 'utf8'),
]);

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

assert.match(
  launcher,
  /HOST_BIND="\$\{MCP_GATEWAY_HOST_BIND:-127\.0\.0\.1\}"/,
  'the only host-published Code Review endpoint must bind to host loopback by default',
);
assert.match(
  launcher,
  /--publish "\$\{HOST_BIND\}:\$\{GATEWAY_PORT\}:38106"/,
  'launcher must publish only the capability-gated front door',
);
assert.doesNotMatch(
  launcher,
  /38107/,
  'the PAT-bearing upstream proxy port must never be published or managed in the host launcher',
);
assert.doesNotMatch(
  launcher,
  /src=\$\{(?:CONFIG_PATH|GITHUB_ENV_PATH)\}/,
  'neither MCP config nor GitHub credential may be bind-mounted from the host into the capability runtime',
);
assert.match(
  launcher,
  /--tmpfs "\/run\/bootstrap:rw,noexec,nosuid,nodev,mode=0700"/,
  'MCP config and GitHub credential must land only in a container-local tmpfs bootstrap area',
);
assert.match(
  launcher,
  /CONFIG_BYTES="\$\(wc -c < "\$CONFIG_PATH"[\s\S]*cat "\$CONFIG_PATH"[\s\S]*cat "\$GITHUB_ENV_PATH"[\s\S]*MCP_BOOTSTRAP_CONFIG_BYTES=\$\{CONFIG_BYTES\}[\s\S]*dd iflag=fullblock bs=1 count="\$MCP_BOOTSTRAP_CONFIG_BYTES" of=\/run\/bootstrap\/config\.json[\s\S]*cat > \/run\/bootstrap\/github\.env/,
  'launcher must frame config by byte count and stream config + GitHub credential over stdin into container tmpfs',
);
assert.doesNotMatch(
  launcher,
  /--env(?:-file)?[^\n]*GITHUB/,
  'GitHub PAT must not be passed in Docker command arguments or container environment configuration',
);
assert.match(
  entrypoint,
  /CONFIG_PATH="\$\{MCP_SUPERASSISTANT_CONFIG:-\/run\/bootstrap\/config\.json\}"/,
  'proxy config must default to the streamed container-tmpfs copy',
);
assert.match(
  entrypoint,
  /GITHUB_ENV_PATH="\$\{MCP_SUPERASSISTANT_GITHUB_ENV:-\/run\/bootstrap\/github\.env\}"/,
  'GitHub credential must default to the streamed container-tmpfs copy',
);
assert.match(
  entrypoint,
  /UPSTREAM_PORT="\$\{MCP_UPSTREAM_PORT:-38107\}"/,
  'the PAT-bearing proxy remains an internal runtime endpoint',
);
assert.match(
  entrypoint,
  /GATEWAY_INTERNAL_PORT="\$\{MCP_GATEWAY_INTERNAL_PORT:-38108\}"/,
  'the capability gateway itself must remain on container loopback behind the public forwarder',
);
assert.match(
  entrypoint,
  /MCP_GATEWAY_HOST="127\.0\.0\.1"/,
  'the capability gateway must continue enforcing its loopback-only client invariant inside the container',
);
assert.match(
  entrypoint,
  /TCP-LISTEN:\$\{PUBLIC_PORT\}.*TCP:127\.0\.0\.1:\$\{GATEWAY_INTERNAL_PORT\}/s,
  'the published port must forward only to the loopback capability gateway, never to the PAT proxy',
);
assert.doesNotMatch(
  dockerfile,
  /apt-get install[^\n]*docker\.io/,
  'secure runtime must not install Debian docker.io because its client API can be older than the host daemon minimum',
);
assert.match(
  dockerfile,
  /ARG DOCKER_CLI_VERSION=27\.5\.1/,
  'secure runtime Docker CLI must be pinned to a modern API-compatible release',
);
assert.match(
  dockerfile,
  /download\.docker\.com\/linux\/static\/stable\/\$\{docker_arch\}\/docker-\$\{DOCKER_CLI_VERSION\}\.tgz/,
  'secure runtime must install the pinned Docker CLI from Docker static releases rather than distro docker.io',
);
assert.match(
  dockerfile,
  /amd64\) docker_arch='x86_64'[\s\S]*arm64\) docker_arch='aarch64'/,
  'secure runtime Docker CLI download must map supported BuildKit architectures explicitly',
);
assert.match(
  dockerfile,
  /docker --version/,
  'secure runtime image build must verify that the modern Docker CLI is installed',
);

console.log('✓ Capability gateway requires an extension credential + active prompt-bound lease and re-enforces read-only repo scope');
console.log('✓ PAT-bearing MCP proxy has no host-published port; host traffic can reach only the capability-gated front door');
console.log('✓ MCP config and GitHub credential are streamed into container tmpfs without host bind-mount permission weakening');
console.log('✓ Secure runtime pins a modern Docker CLI instead of Debian docker.io to avoid host-daemon API incompatibility');
