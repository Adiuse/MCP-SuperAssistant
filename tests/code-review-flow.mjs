import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const gateEntry = path.join(repoRoot, 'chrome-extension/src/security/codeReviewGate.ts');
const backgroundEntry = path.join(repoRoot, 'chrome-extension/src/background/index.ts');
const bridgeEntry = path.join(repoRoot, 'chrome-extension/src/security/codeReviewControlBridge.ts');
const headlessEntry = path.join(
  repoRoot,
  'pages/content/src/components/sidebar/Instructions/HeadlessInstructionSync.tsx',
);

function createStorageArea() {
  const data = Object.create(null);

  const clone = value => (value === undefined ? undefined : structuredClone(value));

  return {
    async get(keys) {
      if (keys == null) return clone(data);

      if (typeof keys === 'string') {
        return { [keys]: clone(data[keys]) };
      }

      if (Array.isArray(keys)) {
        return Object.fromEntries(keys.map(key => [key, clone(data[key])]));
      }

      if (typeof keys === 'object') {
        return Object.fromEntries(
          Object.entries(keys).map(([key, fallback]) => [
            key,
            Object.prototype.hasOwnProperty.call(data, key) ? clone(data[key]) : clone(fallback),
          ]),
        );
      }

      return {};
    },

    async set(items) {
      for (const [key, value] of Object.entries(items || {})) {
        data[key] = clone(value);
      }
    },

    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        delete data[key];
      }
    },

    async clear() {
      for (const key of Object.keys(data)) delete data[key];
    },
  };
}

async function loadGate() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-code-review-test-'));
  const outfile = path.join(tempDir, 'codeReviewGate.mjs');

  await build({
    entryPoints: [gateEntry],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    sourcemap: 'inline',
    logLevel: 'silent',
    plugins: [
      {
        name: 'stub-extension-logger',
        setup(builder) {
          builder.onResolve({ filter: /^@extension\/shared\/lib\/logger$/ }, () => ({
            path: 'logger-stub',
            namespace: 'code-review-test',
          }));
          builder.onLoad({ filter: /.*/, namespace: 'code-review-test' }, () => ({
            loader: 'js',
            contents:
              'export const createLogger = () => ({ debug() {}, warn() {}, error() {}, info() {} });',
          }));
        },
      },
    ],
  });

  return import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
}

async function runOriginIsolationFlow(gate, storage) {
  await storage.clear();

  const CHAT_A = 101;
  const CHAT_B = 202;
  const URL_A = 'https://chatgpt.com/c/code-review-a';
  const URL_B = 'https://chatgpt.com/c/code-review-b';
  const sourcePathA = gate.sourcePathFromUrl(URL_A);

  await gate.saveCodeReviewPreferences({
    owner: 'Adiuse',
    repo: 'cybersecurity',
    durationMinutes: 5,
  });

  const requestTool = await gate.getCodeReviewRequestTool();
  assert.equal(requestTool.name, 'request_code_review_access');
  assert.deepEqual(requestTool.inputSchema.properties, {});
  assert.deepEqual(requestTool.inputSchema.required, []);
  assert.equal(requestTool.inputSchema.additionalProperties, false);

  const request = await gate.createPendingCodeReviewRequest({
    sourceTabId: CHAT_A,
    sourcePath: sourcePathA,
    sourceKey: `${CHAT_A}:${sourcePathA}`,
  });

  assert.equal(request.owner, 'Adiuse');
  assert.equal(request.repo, 'cybersecurity');
  assert.equal(request.durationMinutes, 5);
  assert.equal(request.sourceTabId, CHAT_A);
  assert.ok(request.requestId);

  const pendingBeforeApproval = await gate.getPendingCodeReviewRequests();
  assert.equal(pendingBeforeApproval.length, 1);
  assert.equal(pendingBeforeApproval[0].requestId, request.requestId);
  assert.equal(await gate.getActiveCodeReviewSessionForOrigin(CHAT_A, URL_A), null);
  assert.equal(await gate.getActiveCodeReviewSessionForOrigin(CHAT_B, URL_B), null);

  const serverTools = [
    ...gate.CODE_REVIEW_ALLOWED_TOOLS.map(name => ({ name })),
    { name: 'create_or_update_file' },
    { name: 'delete_file' },
    { name: 'fork_repository' },
  ];

  assert.deepEqual(await gate.filterCodeReviewTools(serverTools, CHAT_A, URL_A), []);
  assert.deepEqual(await gate.filterCodeReviewTools(serverTools, CHAT_B, URL_B), []);

  // Chat B approves the request created by Chat A. Operational access must still
  // be bound to Chat A, not to the approving tab.
  const session = await gate.startCodeReviewSession({
    requestId: request.requestId,
    approvingTabId: CHAT_B,
  });

  assert.equal(session.approvedTabId, CHAT_A);
  assert.equal(session.sourceRequestId, request.requestId);
  assert.equal(session.owner, 'Adiuse');
  assert.equal(session.repo, 'cybersecurity');
  assert.equal(session.durationMinutes, 5);
  assert.equal((await gate.getPendingCodeReviewRequests()).length, 0);

  const chatASession = await gate.getActiveCodeReviewSessionForOrigin(CHAT_A, URL_A);
  const chatBSession = await gate.getActiveCodeReviewSessionForOrigin(CHAT_B, URL_B);
  assert.equal(chatASession?.id, session.id);
  assert.equal(chatBSession, null);

  const chatATools = await gate.filterCodeReviewTools(serverTools, CHAT_A, URL_A);
  const chatBTools = await gate.filterCodeReviewTools(serverTools, CHAT_B, URL_B);

  assert.deepEqual(
    chatATools.map(tool => tool.name),
    [...gate.CODE_REVIEW_ALLOWED_TOOLS],
  );
  assert.deepEqual(chatBTools, []);
  assert.equal(chatATools.some(tool => tool.name === 'create_or_update_file'), false);
  assert.equal(chatATools.some(tool => tool.name === 'delete_file'), false);
  assert.equal(chatATools.some(tool => tool.name === 'fork_repository'), false);

  const authorized = await gate.authorizeCodeReviewToolCall(
    'get_file_contents',
    { owner: 'Adiuse', repo: 'cybersecurity', path: 'README.md' },
    CHAT_A,
    URL_A,
  );
  assert.equal(authorized.sessionId, session.id);
  assert.equal(authorized.args.owner, 'Adiuse');
  assert.equal(authorized.args.repo, 'cybersecurity');
  assert.equal(authorized.args.path, 'README.md');

  const result = await gate.enforceCodeReviewResultPolicy(
    'get_file_contents',
    { content: '# README' },
    authorized.sessionId,
    CHAT_A,
    URL_A,
  );
  assert.deepEqual(result, { content: '# README' });

  await assert.rejects(
    () =>
      gate.authorizeCodeReviewToolCall(
        'get_file_contents',
        { owner: 'Adiuse', repo: 'cybersecurity', path: 'README.md' },
        CHAT_B,
        URL_B,
      ),
    /Code review access is OFF/,
  );

  await assert.rejects(
    () =>
      gate.authorizeCodeReviewToolCall(
        'get_file_contents',
        { owner: 'OtherOwner', repo: 'other-repo', path: 'README.md' },
        CHAT_A,
        URL_A,
      ),
    /scope violation/i,
  );

  const expired = await gate.expireCodeReviewSession(session.id);
  assert.equal(expired?.id, session.id);
  assert.equal(await gate.getActiveCodeReviewSessionForOrigin(CHAT_A, URL_A), null);
  assert.deepEqual(await gate.filterCodeReviewTools(serverTools, CHAT_A, URL_A), []);

  const audit = await gate.getCodeReviewAuditLog();
  const actions = new Set(audit.map(entry => entry.action));
  for (const requiredAction of [
    'access_requested',
    'access_approved',
    'session_started',
    'tool_allowed',
    'response_allowed',
    'tool_denied',
    'scope_violation',
    'session_expired',
  ]) {
    assert.equal(actions.has(requiredAction), true, `missing audit action: ${requiredAction}`);
  }
}

async function runRequestIdQueueFlow(gate, storage) {
  await storage.clear();

  await gate.saveCodeReviewPreferences({
    owner: 'Adiuse',
    repo: 'cybersecurity',
    durationMinutes: 5,
  });

  const requestA = await gate.createPendingCodeReviewRequest({
    sourceTabId: 301,
    sourcePath: '/c/request-a',
    sourceKey: '301:/c/request-a',
  });
  const requestC = await gate.createPendingCodeReviewRequest({
    sourceTabId: 303,
    sourcePath: '/c/request-c',
    sourceKey: '303:/c/request-c',
  });

  const sessionC = await gate.startCodeReviewSession({
    requestId: requestC.requestId,
    approvingTabId: 302,
  });

  assert.equal(sessionC.approvedTabId, 303);
  assert.equal(sessionC.sourceRequestId, requestC.requestId);

  const remaining = await gate.getPendingCodeReviewRequests();
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].requestId, requestA.requestId);

  const revoked = await gate.revokeCodeReviewSession(
    sessionC.id,
    'test cleanup exact-session revoke',
    302,
  );
  assert.equal(revoked?.id, sessionC.id);
}

async function runSourceContractChecks() {
  const [background, bridge, headless] = await Promise.all([
    fs.readFile(backgroundEntry, 'utf8'),
    fs.readFile(bridgeEntry, 'utf8'),
    fs.readFile(headlessEntry, 'utf8'),
  ]);

  assert.equal(
    background.includes('broadcastToolsUpdateToContentScripts'),
    false,
    'background must never restore global MCP tool broadcasting',
  );
  assert.equal(
    background.includes('ToolUpdateBroadcast'),
    false,
    'background must not import/use the old global tool broadcast payload',
  );

  assert.match(
    background,
    /getPrimitivesWithBackwardsCompatibility\([\s\S]{0,260}?connectionType,\s*tabId,\s*sender\.tab\?\.url,?\s*\)/,
    'tool discovery must pass sender tab id/url into the gate',
  );
  assert.match(
    background,
    /callToolWithBackwardsCompatibility\([\s\S]{0,420}?connectionType,\s*callerTabId,\s*sender\.tab\?\.url,?\s*\)/,
    'tool execution must pass sender tab id/url into the gate',
  );

  assert.match(
    bridge,
    /pendingRequests\.find\(request => request\.requestId === requestId\)/,
    'approval must select the exact pending request by requestId',
  );
  assert.match(
    bridge,
    /expireCodeReviewSession\(event\.sessionId\)/,
    'expiry alarm must remove the exact session immediately',
  );

  const readToolsCheck = headless.indexOf('const hasReadTools = currentTools.some');
  const instructionsCheck = headless.indexOf('READ_TOOL_PATTERN.test(updatedInstructions)');
  const insertContinuation = headless.indexOf('await adapter.insertText(continuation)');
  const submitContinuation = headless.indexOf('await adapter.submitForm()');

  assert.ok(readToolsCheck >= 0, 'auto-resume must verify read tools are exposed');
  assert.ok(instructionsCheck > readToolsCheck, 'auto-resume must verify model instructions after tool exposure');
  assert.ok(insertContinuation > instructionsCheck, 'auto-resume cannot inject continuation before tool verification');
  assert.ok(submitContinuation > insertContinuation, 'auto-resume submits only after verified continuation insertion');
}

const storage = createStorageArea();
globalThis.chrome = {
  storage: {
    local: storage,
  },
};

const gate = await loadGate();

await runOriginIsolationFlow(gate, storage);
console.log('✓ Chat A request → Chat B approve → GitHub read tools only in Chat A → expiry removes access');

await runRequestIdQueueFlow(gate, storage);
console.log('✓ Global pending queue approval targets the selected requestId, not the first request');

await runSourceContractChecks();
console.log('✓ Background has no global tool broadcast and auto-resume waits for verified read tools');
