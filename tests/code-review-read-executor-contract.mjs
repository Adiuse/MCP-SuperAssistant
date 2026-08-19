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
assert.match(source, /type:\s*MCP_CALL_MESSAGE/);
assert.match(source, /toolName:\s*call\.toolName/);
assert.match(source, /<function_result call_id=/);
assert.match(source, /await adapter\.insertText\(wrapper\)/);
assert.match(source, /await adapter\.submitForm\(\)/);
assert.match(source, /if \(disposed \|\| generalAutoExecuteEnabled\(\)\) return;/);
assert.match(
  source,
  /querySelectorAll<HTMLElement>\('\.function-block \.xml-results-panel pre'\)/,
  'approved reads must be detected from the renderer raw-info panel inside the real function card',
);
assert.doesNotMatch(
  source,
  /source\.closest\('\.function-block'\)\) return/,
  'the executor must not skip the rendered function card that contains the real model read call',
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
window.__mcpAutomationState = { autoExecute: true };
assert.equal(utils.generalAutoExecuteEnabled(), true);
window.__mcpAutomationState = undefined;
window.toggleState = { autoExecute: false };
assert.equal(utils.generalAutoExecuteEnabled(), false);
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

console.log('✓ Approved Code Review reads execute from rendered function cards through the origin-scoped Gate pipeline');
