import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const entry = path.join(repoRoot, 'chrome-extension/src/security/codeReviewToolAlias.ts');
const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-code-review-alias-'));
const outfile = path.join(tempDir, 'alias.mjs');

await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  logLevel: 'silent',
});

const { aliasScopedTools, resolveScopedServerToolName } = await import(
  `${pathToFileURL(outfile).href}?t=${Date.now()}`
);

const allowed = [
  'get_me',
  'get_file_contents',
  'search_code',
  'list_commits',
];

const namespaced = [
  { name: 'github.get_me', description: 'me' },
  { name: 'github.get_file_contents', description: 'read' },
  { name: 'github.search_code', description: 'search' },
  { name: 'github.list_commits', description: 'commits' },
  { name: 'github.create_or_update_file', description: 'write' },
  { name: 'filesystem.read_text_file', description: 'other server' },
];

const exposed = aliasScopedTools(namespaced, allowed);
assert.deepEqual(
  exposed.map(tool => tool.name),
  allowed,
  'namespaced GitHub read tools must be exposed under canonical allowlisted names',
);
assert.equal(exposed.some(tool => tool.name === 'create_or_update_file'), false);
assert.equal(exposed.some(tool => tool.name === 'read_text_file'), false);

assert.equal(
  resolveScopedServerToolName(namespaced, 'get_file_contents', allowed),
  'github.get_file_contents',
  'canonical model call must resolve back to the exact proxy tool name',
);

const exactWins = [
  { name: 'get_file_contents' },
  { name: 'github.get_file_contents' },
];
assert.equal(
  resolveScopedServerToolName(exactWins, 'get_file_contents', allowed),
  'get_file_contents',
  'an exact server tool name must win over a prefixed alias',
);
assert.deepEqual(aliasScopedTools(exactWins, allowed).map(tool => tool.name), ['get_file_contents']);

const ambiguous = [
  { name: 'github.get_file_contents' },
  { name: 'other.get_file_contents' },
];
assert.equal(
  aliasScopedTools(ambiguous, allowed).some(tool => tool.name === 'get_file_contents'),
  false,
  'ambiguous namespaces must not expose a capability to the model',
);
assert.throws(
  () => resolveScopedServerToolName(ambiguous, 'get_file_contents', allowed),
  /ambiguous/i,
);

console.log('✓ Namespaced GitHub MCP tools map to canonical read-only aliases without exposing writes');
