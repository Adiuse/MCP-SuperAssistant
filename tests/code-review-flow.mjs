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
const headlessEntry = path.join(repoRoot, 'pages/content/src/components/sidebar/Instructions/HeadlessInstructionSync.tsx');
const userTurnEntry = path.join(repoRoot, 'pages/content/src/security/codeReviewUserTurn.ts');
const securityToastEntry = path.join(repoRoot, 'pages/content/src/components/mcpPopover/securityToast.ts');

function createStorageArea() {
  const data = Object.create(null);
  const clone = value => (value === undefined ? undefined : structuredClone(value));
  return {
    async get(keys) {
      if (keys == null) return clone(data);
      if (typeof keys === 'string') return { [keys]: clone(data[keys]) };
      if (Array.isArray(keys)) return Object.fromEntries(keys.map(key => [key, clone(data[key])]));
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
      for (const [key, value] of Object.entries(items || {})) data[key] = clone(value);
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key];
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
            contents: 'export const createLogger = () => ({ debug() {}, warn() {}, error() {}, info() {} });',
          }));
        },
      },
    ],
  });
  return import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
}

async function beginHumanTurn(gate, tabId, url, submissionId) {
  return gate.registerCodeReviewUserTurn({
    sourceTabId: tabId,
    sourceUrl: url,
    clientSubmissionId: submissionId,
  });
}

async function runPromptBoundIsolationFlow(gate, storage) {
  await storage.clear();

  const CHAT_A = 101;
  const CHAT_B = 202;
  const URL_A = 'https://chatgpt.com/c/code-review-a';
  const URL_A_QUERY = 'https://chatgpt.com/c/code-review-a?model=gpt-5#composer';
  const URL_B = 'https://chatgpt.com/c/code-review-b';
  const sourcePathA = gate.sourcePathFromUrl(URL_A);

  assert.equal(sourcePathA, '/c/code-review-a');
  assert.equal(gate.sourcePathFromUrl(URL_A_QUERY), sourcePathA);
  assert.equal(gate.sourcePathFromUrl('/c/code-review-a?model=gpt-5#composer'), sourcePathA);

  await gate.saveCodeReviewPreferences({ owner: 'Adiuse', repo: 'cybersecurity', durationMinutes: 5 });

  const requestTool = await gate.getCodeReviewRequestTool();
  assert.equal(requestTool.name, 'request_code_review_access');
  assert.deepEqual(requestTool.inputSchema.properties, {});
  assert.equal(requestTool.inputSchema.additionalProperties, false);
  assert.match(requestTool.description, /current real user prompt/i);

  // Fail closed: merely having a chat/origin is not enough to manufacture an
  // approval request. A browser-trusted human turn must be registered first.
  await assert.rejects(
    () => gate.createPendingCodeReviewRequest({ sourceTabId: CHAT_A, sourcePath: sourcePathA }),
    /Prompt واقعی|real/i,
  );

  const turnA = await beginHumanTurn(gate, CHAT_A, URL_A, 'human-submit-a1');
  assert.ok(turnA.userTurn.id);
  assert.equal(turnA.invalidatedSessions.length, 0);

  const duplicateSignal = await beginHumanTurn(gate, CHAT_A, URL_A_QUERY, 'human-submit-a1');
  assert.equal(duplicateSignal.deduplicated, true);
  assert.equal(duplicateSignal.userTurn.id, turnA.userTurn.id);

  const request = await gate.createPendingCodeReviewRequest({
    sourceTabId: CHAT_A,
    sourcePath: sourcePathA,
    sourceKey: 'ignored-untrusted-source-key',
  });
  assert.equal(request.userTurnId, turnA.userTurn.id);
  assert.ok(request.jobId);
  assert.equal(request.owner, 'Adiuse');
  assert.equal(request.repo, 'cybersecurity');

  // Another chat may approve the exact global pending request, but the
  // operational capability remains at the request origin and prompt.
  const session = await gate.startCodeReviewSession({ requestId: request.requestId, approvingTabId: CHAT_B });
  assert.equal(session.approvedTabId, CHAT_A);
  assert.equal(session.userTurnId, turnA.userTurn.id);
  assert.equal(session.jobId, request.jobId);
  assert.ok(session.capabilityId);

  assert.equal((await gate.getActiveCodeReviewSessionForOrigin(CHAT_A, URL_A_QUERY))?.id, session.id);
  assert.equal(await gate.getActiveCodeReviewSessionForOrigin(CHAT_B, URL_B), null);

  const serverTools = [
    ...gate.CODE_REVIEW_ALLOWED_TOOLS.map(name => ({ name })),
    { name: 'create_or_update_file' },
    { name: 'delete_file' },
  ];
  const chatATools = await gate.filterCodeReviewTools(serverTools, CHAT_A, URL_A_QUERY);
  assert.deepEqual(chatATools.map(tool => tool.name), [...gate.CODE_REVIEW_ALLOWED_TOOLS]);
  assert.equal(chatATools.some(tool => tool.name === 'delete_file'), false);

  // Same approved prompt can traverse the entire repo repeatedly without a new
  // approval. This is required for architecture/E2E review.
  const fileAuth = await gate.authorizeCodeReviewToolCall(
    'get_file_contents',
    { owner: 'Adiuse', repo: 'cybersecurity', path: 'README.md' },
    CHAT_A,
    URL_A_QUERY,
  );
  assert.equal(fileAuth.sessionId, session.id);
  assert.equal(fileAuth.userTurnId, turnA.userTurn.id);
  assert.equal(fileAuth.jobId, session.jobId);
  assert.equal(fileAuth.capabilityId, session.capabilityId);

  const searchAuth = await gate.authorizeCodeReviewToolCall(
    'search_code',
    { query: 'PaymentService' },
    CHAT_A,
    URL_A,
  );
  assert.match(searchAuth.args.query, /PaymentService repo:Adiuse\/cybersecurity/);

  const result = await gate.enforceCodeReviewResultPolicy(
    'get_file_contents',
    { content: '# README' },
    fileAuth.sessionId,
    CHAT_A,
    URL_A_QUERY,
  );
  assert.deepEqual(result, { content: '# README' });

  await assert.rejects(
    () => gate.authorizeCodeReviewToolCall('get_file_contents', { path: 'README.md' }, CHAT_B, URL_B),
    /OFF for this prompt/i,
  );
  await assert.rejects(
    () =>
      gate.authorizeCodeReviewToolCall(
        'get_file_contents',
        { owner: 'OtherOwner', repo: 'other-repo', path: 'README.md' },
        CHAT_A,
        URL_A_QUERY,
      ),
    /scope violation/i,
  );
  await assert.rejects(
    () => gate.authorizeCodeReviewToolCall('search_code', { query: 'secret repo:Other/repo' }, CHAT_A, URL_A),
    /scope qualifiers/i,
  );

  // Attacker/new-human-prompt scenario. The old lease may still have wall-clock
  // time left, but a new real UserTurn invalidates it immediately.
  const inFlight = await gate.authorizeCodeReviewToolCall(
    'get_file_contents',
    { path: 'src/payments/service.ts' },
    CHAT_A,
    URL_A,
  );
  const attackerTurn = await beginHumanTurn(gate, CHAT_A, URL_A, 'human-submit-attacker');
  assert.notEqual(attackerTurn.userTurn.id, turnA.userTurn.id);
  assert.deepEqual(attackerTurn.invalidatedSessions.map(item => item.id), [session.id]);
  assert.equal(await gate.getActiveCodeReviewSessionForOrigin(CHAT_A, URL_A), null);

  await assert.rejects(
    () => gate.authorizeCodeReviewToolCall('get_file_contents', { path: 'src/private.ts' }, CHAT_A, URL_A),
    /OFF for this prompt/i,
  );
  await assert.rejects(
    () =>
      gate.enforceCodeReviewResultPolicy(
        'get_file_contents',
        { content: 'must never reach the model after a new user turn' },
        inFlight.sessionId,
        CHAT_A,
        URL_A,
      ),
    /lease ended/i,
  );

  // The new real prompt can request a fresh approval; the old lease is never
  // reused even though its original expiresAt was still in the future.
  const request2 = await gate.createPendingCodeReviewRequest({ sourceTabId: CHAT_A, sourcePath: sourcePathA });
  assert.equal(request2.userTurnId, attackerTurn.userTurn.id);
  assert.notEqual(request2.jobId, request.jobId);
  const session2 = await gate.startCodeReviewSession({ requestId: request2.requestId, approvingTabId: CHAT_A });
  assert.equal(session2.userTurnId, attackerTurn.userTurn.id);
  await gate.expireCodeReviewSession(session2.id);
  assert.equal(await gate.getActiveCodeReviewSessionForOrigin(CHAT_A, URL_A_QUERY), null);

  const audit = await gate.getCodeReviewAuditLog();
  const actions = new Set(audit.map(entry => entry.action));
  for (const requiredAction of [
    'access_requested',
    'access_approved',
    'session_started',
    'job_started',
    'tool_allowed',
    'response_allowed',
    'tool_denied',
    'scope_violation',
    'new_user_turn_invalidated_old_job',
    'job_revoked',
    'session_expired',
    'job_expired',
  ]) {
    assert.equal(actions.has(requiredAction), true, `missing audit action: ${requiredAction}`);
  }
}

async function runStalePendingFlow(gate, storage) {
  await storage.clear();
  await gate.saveCodeReviewPreferences({ owner: 'Adiuse', repo: 'cybersecurity', durationMinutes: 10 });
  const URL = 'https://chatgpt.com/c/stale-request';
  await beginHumanTurn(gate, 301, URL, 'human-stale-a');
  const oldRequest = await gate.createPendingCodeReviewRequest({ sourceTabId: 301, sourcePath: '/c/stale-request' });
  const next = await beginHumanTurn(gate, 301, URL, 'human-stale-b');
  assert.deepEqual(next.invalidatedRequests.map(item => item.requestId), [oldRequest.requestId]);
  assert.equal((await gate.getPendingCodeReviewRequests()).length, 0);
  await assert.rejects(
    () => gate.startCodeReviewSession({ requestId: oldRequest.requestId, approvingTabId: 301 }),
    /no longer pending/i,
  );
}

async function runRequestIdQueueFlow(gate, storage) {
  await storage.clear();
  await gate.saveCodeReviewPreferences({ owner: 'Adiuse', repo: 'cybersecurity', durationMinutes: 5 });
  await beginHumanTurn(gate, 401, 'https://chatgpt.com/c/request-a', 'human-a');
  await beginHumanTurn(gate, 403, 'https://chatgpt.com/c/request-c', 'human-c');
  const requestA = await gate.createPendingCodeReviewRequest({ sourceTabId: 401, sourcePath: '/c/request-a' });
  const requestC = await gate.createPendingCodeReviewRequest({ sourceTabId: 403, sourcePath: '/c/request-c' });
  const sessionC = await gate.startCodeReviewSession({ requestId: requestC.requestId, approvingTabId: 402 });
  assert.equal(sessionC.approvedTabId, 403);
  assert.equal(sessionC.sourceRequestId, requestC.requestId);
  const remaining = await gate.getPendingCodeReviewRequests();
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].requestId, requestA.requestId);
  const revoked = await gate.revokeCodeReviewSession(sessionC.id, 'test exact-session revoke', 402);
  assert.equal(revoked?.id, sessionC.id);
}

async function runSourceContractChecks() {
  const [background, bridge, headless, userTurn, securityToast] = await Promise.all([
    fs.readFile(backgroundEntry, 'utf8'),
    fs.readFile(bridgeEntry, 'utf8'),
    fs.readFile(headlessEntry, 'utf8'),
    fs.readFile(userTurnEntry, 'utf8'),
    fs.readFile(securityToastEntry, 'utf8'),
  ]);

  assert.equal(background.includes('broadcastToolsUpdateToContentScripts'), false);
  assert.equal(background.includes('ToolUpdateBroadcast'), false);
  assert.match(
    background,
    /getPrimitivesWithBackwardsCompatibility\([\s\S]{0,260}?connectionType,\s*tabId,\s*sender\.tab\?\.url,?\s*\)/,
  );
  assert.match(
    background,
    /callToolWithBackwardsCompatibility\([\s\S]{0,420}?connectionType,\s*callerTabId,\s*sender\.tab\?\.url,?\s*\)/,
  );

  assert.match(bridge, /USER_TURN:\s*'code-review:user-turn'/);
  assert.match(bridge, /registerCodeReviewUserTurn\(/);
  assert.match(bridge, /session:\s*originSession,/);
  assert.doesNotMatch(bridge, /originSession\s*\|\|\s*fallbackSession/);
  assert.match(bridge, /pendingRequests\.find\(request => request\.requestId === requestId\)/);
  assert.match(bridge, /expireCodeReviewSession\(event\.sessionId\)/);
  assert.match(bridge, /clearCodeReviewExpiryNotification\(invalidated\.id\)/);

  assert.match(userTurn, /event\.isTrusted/);
  assert.match(userTurn, /document\.addEventListener\('click',[\s\S]*true\)/);
  assert.match(userTurn, /document\.addEventListener\('keydown',[\s\S]*true\)/);
  assert.doesNotMatch(userTurn, /addEventListener\('submit'/);
  assert.match(userTurn, /code-review:user-turn/);
  assert.match(userTurn, /Fail closed/);
  assert.match(securityToast, /security\/codeReviewUserTurn/);

  const readToolsCheck = headless.indexOf('const hasReadTools = currentTools.some');
  const instructionsCheck = headless.indexOf('READ_TOOL_PATTERN.test(updatedInstructions)');
  const insertContinuation = headless.indexOf('await adapter.insertText(continuation)');
  const submitContinuation = headless.indexOf('await adapter.submitForm()');
  assert.ok(readToolsCheck >= 0);
  assert.ok(instructionsCheck > readToolsCheck);
  assert.ok(insertContinuation > instructionsCheck);
  assert.ok(submitContinuation > insertContinuation);
}

const storage = createStorageArea();
globalThis.chrome = { storage: { local: storage } };
const gate = await loadGate();

await runPromptBoundIsolationFlow(gate, storage);
console.log('✓ Same prompt supports repo-wide reads; a new real user turn invalidates the lease and in-flight result');
await runStalePendingFlow(gate, storage);
console.log('✓ A new real user turn removes a stale pending approval request');
await runRequestIdQueueFlow(gate, storage);
console.log('✓ Global pending approval remains exact-requestId while operational access stays origin/prompt-bound');
await runSourceContractChecks();
console.log('✓ Trusted user-turn detector and origin-scoped background/control contracts are present');
