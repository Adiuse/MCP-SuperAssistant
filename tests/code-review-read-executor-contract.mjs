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
  /querySelector<HTMLButtonElement>\('\.execute-button'\)/,
  'approved reads must trigger the renderer native Run button',
);
assert.match(source, /executeButton\.click\(\)/);
assert.match(
  source,
  /querySelector<HTMLButtonElement>\('\.insert-result-button'\)/,
  'approved read results must use the renderer native Insert button when Auto Insert is off',
);
assert.match(source, /insertButton\.click\(\)/);
assert.match(source, /await adapter\.submitForm\(\)/);
assert.match(
  source,
  /querySelectorAll<HTMLElement>\('\.function-block \.xml-results-panel pre'\)/,
  'the security bridge may identify calls only from renderer-owned raw-info panels',
);
assert.doesNotMatch(
  source,
  /MCP_CALL_MESSAGE|type:\s*['"]mcp:call-tool['"]|toolName:\s*call\.toolName/,
  'approved reads must not directly call MCP from the security bridge',
);
assert.doesNotMatch(
  source,
  /<function_result call_id=|insertText\(wrapper\)|resultToText/,
  'the security bridge must not build or inject tool results itself',
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

window.__mcpAutomationState = { autoExecute: false, autoInsert: false, autoSubmit: false };
assert.equal(utils.generalAutoExecuteEnabled(), false);
assert.deepEqual(utils.getAutomationState(), {
  autoExecute: false,
  autoInsert: false,
  autoSubmit: false,
  autoInsertDelay: 0,
  autoSubmitDelay: 0,
});

window.__mcpAutomationState = {
  autoExecute: true,
  autoInsert: true,
  autoSubmit: true,
  autoInsertDelay: 2,
  autoSubmitDelay: 3,
};
assert.equal(utils.generalAutoExecuteEnabled(), true);
assert.deepEqual(utils.getAutomationState(), {
  autoExecute: true,
  autoInsert: true,
  autoSubmit: true,
  autoInsertDelay: 2,
  autoSubmitDelay: 3,
});

window.__mcpAutomationState = undefined;
window.toggleState = { autoExecute: false, autoInsert: true, autoSubmit: false };
assert.deepEqual(utils.getAutomationState(), {
  autoExecute: false,
  autoInsert: true,
  autoSubmit: false,
  autoInsertDelay: 0,
  autoSubmitDelay: 0,
});
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

console.log('✓ Approved Code Review reads reuse the upstream Run/Insert pipeline and only add origin-scoped policy');
