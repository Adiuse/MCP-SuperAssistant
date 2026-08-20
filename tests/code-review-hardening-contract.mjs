import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const read = relative => fs.readFile(path.join(root, relative), 'utf8');

const [
  popover,
  approvalUi,
  mcpClient,
  transport,
  background,
  bridge,
  gatewayCapability,
  gateway,
  launcher,
  dockerfile,
  runtimeConfig,
  headless,
  readExecutor,
  userTurn,
] = await Promise.all([
  read('pages/content/src/components/mcpPopover/PopoverPortal.tsx'),
  read('pages/content/src/components/CodeReviewAccessFa.tsx'),
  read('chrome-extension/src/mcpclient/index.ts'),
  read('chrome-extension/src/mcpclient/plugins/streamable-http/StreamableHttpPlugin.ts'),
  read('chrome-extension/src/background/index.ts'),
  read('chrome-extension/src/security/codeReviewControlBridge.ts'),
  read('chrome-extension/src/security/codeReviewGatewayCapability.ts'),
  read('local-mcp/code-review-capability-gateway.mjs'),
  read('local-mcp/start-secure-code-review.sh'),
  read('local-mcp/secure-runtime.Dockerfile'),
  read('local-mcp/config.json'),
  read('pages/content/src/components/sidebar/Instructions/HeadlessInstructionSync.tsx'),
  read('pages/content/src/components/mcpPopover/codeReviewReadExecutor.ts'),
  read('pages/content/src/security/codeReviewUserTurn.ts'),
]);

assert.match(popover, /attachShadow\(\{ mode: 'closed' \}\)/);
assert.match(popover, /injectTailwindToShadowDom\(shadowRoot\)/);
assert.match(approvalUi, /تأیید مصنوعی مسدود شد/);
assert.match(approvalUi, /event\.nativeEvent\.isTrusted/);

assert.match(gatewayCapability, /capabilityToken: session\.capabilityToken/);
assert.match(gatewayCapability, /originTabId: authorization\.originTabId/);
assert.match(gatewayCapability, /sourcePath: authorization\.sourcePath/);
assert.match(mcpClient, /ensureCodeReviewGatewaySynchronized\(\)/);
assert.match(mcpClient, /attachCodeReviewCapability\(authorization\.args, authorization\)/);
assert.match(transport, /isCanonicalCodeReviewGateway\(uri, 'streamable-http'\)/);

assert.match(background, /serverUrl = SECURE_CODE_REVIEW_GATEWAY_URL/);
assert.match(background, /connectionType = DEFAULT_CONNECTION_TYPE/);
assert.match(background, /config\.connectionType !== SECURE_CODE_REVIEW_TRANSPORT/);
assert.doesNotMatch(bridge, /BestEffort|bestEffort/);
assert.match(bridge, /revokeGatewayLeaseRequired/);
assert.match(gatewayCapability, /mcpCodeReviewGatewayPendingRevocations/);

assert.match(gateway, /MCP method '\$\{method\}' is not allowed/);
assert.match(gateway, /JSON-RPC batches are disabled/);
assert.match(gateway, /MAX_TOOL_CALLS = 200/);
assert.match(gateway, /MAX_SINGLE_RESPONSE_BYTES = 2 \* 1024 \* 1024/);
assert.match(gateway, /MAX_LEASE_RESPONSE_BYTES = 25 \* 1024 \* 1024/);
assert.match(gateway, /OR\|NOT/);

assert.doesNotMatch(launcher, /docker\.sock/);
assert.doesNotMatch(dockerfile, /docker\.com\/linux\/static|\/usr\/local\/bin\/docker/);
assert.match(dockerfile, /COPY --from=github-mcp/);
assert.match(runtimeConfig, /"command": "\/usr\/local\/bin\/github-mcp-server"/);

assert.match(headless, /isAssistantModelOutput\(source\)/);
assert.match(readExecutor, /isAssistantModelOutput\(source\)/);
assert.match(userTurn, /ordinal:\$\{ordinal\}/);

console.log(
  '✓ Eleven audited hardening findings have executable source contracts across UI, Extension, Gateway and Runtime',
);
