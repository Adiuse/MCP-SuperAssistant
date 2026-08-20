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

const { aliasScopedTools, canonicalizeScopedToolName, resolveScopedServerToolName } = await import(
  `${pathToFileURL(outfile).href}?t=${Date.now()}`
);

const allowed = ['get_me', 'get_file_contents', 'search_code', 'list_commits'];

const namespaceVariants = [
  'github-review.get_file_contents',
  'github-review/get_file_contents',
  'github-review:get_file_contents',
  'github-review__get_file_contents',
];
for (const name of namespaceVariants) {
  assert.equal(
    canonicalizeScopedToolName(name, allowed),
    'get_file_contents',
    `GitHub proxy namespace variant must canonicalize: ${name}`,
  );
}

for (const unrelated of [
  'filesystem.get_file_contents',
  'other__get_file_contents',
  'githubish_get_file_contents',
  'github.get_file_contents',
  'github_review_get_file_contents',
  'mcp.github-review__get_file_contents',
]) {
  assert.equal(
    canonicalizeScopedToolName(unrelated, allowed),
    null,
    `non-GitHub namespace must not gain Code Review capability: ${unrelated}`,
  );
}

const namespaced = [
  { name: 'github-review__get_me', description: 'me' },
  { name: 'github-review__get_file_contents', description: 'read' },
  { name: 'github-review__search_code', description: 'search' },
  { name: 'github-review__list_commits', description: 'commits' },
  { name: 'github-review__create_or_update_file', description: 'write' },
  { name: 'filesystem__read_text_file', description: 'other server' },
];

const exposed = aliasScopedTools(namespaced, allowed);
assert.deepEqual(
  exposed.map(tool => tool.name),
  allowed,
  'github-review namespaced read tools must be exposed under canonical allowlisted names',
);
assert.equal(
  exposed.some(tool => tool.name === 'create_or_update_file'),
  false,
);
assert.equal(
  exposed.some(tool => tool.name === 'read_text_file'),
  false,
);

assert.equal(
  resolveScopedServerToolName(namespaced, 'get_file_contents', allowed),
  'github-review__get_file_contents',
  'canonical model call must resolve back to the exact proxy tool name',
);

const exactWins = [{ name: 'get_file_contents' }, { name: 'github-review__get_file_contents' }];
assert.equal(
  resolveScopedServerToolName(exactWins, 'get_file_contents', allowed),
  'get_file_contents',
  'an exact server tool name must win over a prefixed alias',
);
assert.deepEqual(
  aliasScopedTools(exactWins, allowed).map(tool => tool.name),
  ['get_file_contents'],
);

const unrelatedSameSuffix = [{ name: 'github-review__get_file_contents' }, { name: 'filesystem.get_file_contents' }];
assert.equal(
  resolveScopedServerToolName(unrelatedSameSuffix, 'get_file_contents', allowed),
  'github-review__get_file_contents',
  'a same-suffix tool from a non-GitHub namespace must not create ambiguity',
);

const ambiguousGitHubAliases = [
  { name: 'github-review.get_file_contents' },
  { name: 'github-review__get_file_contents' },
];
assert.equal(
  aliasScopedTools(ambiguousGitHubAliases, allowed).some(tool => tool.name === 'get_file_contents'),
  false,
  'multiple GitHub namespace aliases without an exact server name must remain ambiguous',
);
assert.throws(() => resolveScopedServerToolName(ambiguousGitHubAliases, 'get_file_contents', allowed), /ambiguous/i);

console.log('✓ GitHub-review MCP namespace variants map safely to canonical read-only aliases');
