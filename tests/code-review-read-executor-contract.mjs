import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const entry = path.join(
  repoRoot,
  'pages/content/src/components/mcpPopover/codeReviewReadExecutor.ts',
);

const source = await fs.readFile(entry, 'utf8');

assert.match(source, /response\.originSession/);
assert.match(
  source,
  /window\.mcpClient/,
  'approved reads must reuse the page MCP client used by the renderer',
);
assert.match(
  source,
  /mcpClient\.callTool\(call\.toolName, call\.args\)/,
  'approved reads must execute through the shared MCP client callTool API',
);
assert.match(source, /await adapter\.insertText\(wrapper\)/);
assert.match(source, /await adapter\.submitForm\(\)/);
assert.match(source, /<function_result call_id=/);
assert.match(
  source,
  /querySelectorAll<HTMLElement>\('\.function-block \.xml-results-panel pre'\)/,
  'the bridge may identify calls only from renderer-owned raw-info panels',
);
assert.match(source, /MAX_EXECUTION_ATTEMPTS\s*=\s*3/);
assert.match(source, /MAX_RESULT_SUBMIT_ATTEMPTS\s*=\s*3/);
assert.match(source, /data-code-review-read-final-error/);
assert.match(source, /parseGitHubDeviceAuthChallenge\(result\)/);
assert.match(source, /data-code-review-read-auth-required/);
assert.match(source, /item\?\.type === 'resource'/);
assert.match(source, /item\?\.resource\?\.text/);
assert.match(source, /resultBySource\.set\(source, \{ key, result \}\)/);
assert.match(source, /composerContainsResult\(call\.callId\)/);
assert.match(
  source,
  /کد ورود برای امنیت به مدل ارسال نشد/,
  'GitHub device-login challenges must be kept out of model context',
);
assert.doesNotMatch(
  source,
  /querySelector[^\n]*\.execute-button|executeButton\.click\(\)/,
  'approved reads must not depend on locating or clicking the renderer Run button',
);
assert.doesNotMatch(
  source,
  /querySelector[^\n]*\.insert-result-button|insertButton\.click\(\)/,
  'approved reads must not depend on locating or clicking the renderer Insert button',
);
assert.doesNotMatch(
  source,
  /MCP_CALL_MESSAGE|type:\s*['"]mcp:call-tool['"]/,
  'the bridge must not bypass the shared MCP client with a direct background tool call',
);
assert.doesNotMatch(source, /request_code_review_access/);

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-read-executor-test-'));
const outfile = path.join(tempDir, 'executor.mjs');

await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  logLevel: 'silent',
});

globalThis.window = {
  location: { pathname: '/c/test', search: '?model=gpt-5' },
};

const mod = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
const utils = mod.codeReviewReadExecutorTestUtils;

window.__mcpAutomationState = { autoExecute: false };
assert.equal(utils.generalAutoExecuteEnabled(), false);
assert.deepEqual(utils.getAutomationState(), { autoExecute: false });

window.__mcpAutomationState = { autoExecute: true };
assert.equal(utils.generalAutoExecuteEnabled(), true);
assert.deepEqual(utils.getAutomationState(), { autoExecute: true });

window.__mcpAutomationState = undefined;
window.toggleState = { autoExecute: false };
assert.deepEqual(utils.getAutomationState(), { autoExecute: false });
window.toggleState = undefined;
assert.equal(
  utils.generalAutoExecuteEnabled(),
  false,
  'missing automation state must mirror the renderer effective default: Auto Execute OFF',
);

const readCall = [
  '{"type":"function_call_start","name":"get_file_contents","call_id":7}',
  '{"type":"description","text":"Read README"}',
  '{"type":"parameter","key":"owner","value":"Adiuse"}',
  '{"type":"parameter","key":"repo","value":"cybersecurity"}',
  '{"type":"parameter","key":"path","value":"README.md"}',
  '{"type":"function_call_end","call_id":7}',
].join('\n');

assert.deepEqual(utils.parseApprovedReadCall(readCall), {
  toolName: 'get_file_contents',
  callId: '7',
  args: {
    owner: 'Adiuse',
    repo: 'cybersecurity',
    path: 'README.md',
  },
});

assert.equal(
  utils.parseApprovedReadCall(
    '{"type":"function_call_start","name":"create_or_update_file","call_id":8}\n' +
      '{"type":"function_call_end","call_id":8}',
  ),
  null,
);

assert.equal(
  utils.parseApprovedReadCall(
    '{"type":"function_call_start","name":"get_file_contents","call_id":9}\n' +
      '{"type":"parameter","key":"path","value":"README.md"}',
  ),
  null,
);

assert.equal(
  utils.resultToText({ content: [{ type: 'text', text: '# README' }] }),
  '# README',
);

assert.equal(
  utils.resultToText({
    content: [
      { type: 'text', text: 'successfully downloaded text file (SHA: abc123)' },
      {
        type: 'resource',
        resource: {
          uri: 'repo://Adiuse/cybersecurity/main/contents/README.md',
          mimeType: 'text/plain; charset=utf-8',
          text: '# Real README\n\nActual repository content.',
        },
      },
    ],
  }),
  'successfully downloaded text file (SHA: abc123)\n\n# Real README\n\nActual repository content.',
  'embedded MCP resource text from GitHub get_file_contents must reach the model',
);

const authChallengeText =
  'Visit https://github.com/login/device and enter the code 31FC-ADD4 to authorize the GitHub MCP Server. ' +
  'After authorizing, retry your request.';
assert.deepEqual(
  utils.parseGitHubDeviceAuthChallenge({ content: [{ type: 'text', text: authChallengeText }] }),
  {
    verificationUrl: 'https://github.com/login/device',
    userCode: '31FC-ADD4',
  },
);
assert.equal(
  utils.parseGitHubDeviceAuthChallenge({ content: [{ type: 'text', text: '# README' }] }),
  null,
);

console.log('✓ Approved Code Review reads preserve MCP resource text, verify result delivery, and keep GitHub auth challenges out of model context');