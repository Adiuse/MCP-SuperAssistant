import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const headlessPath = path.join(
  repoRoot,
  'pages/content/src/components/sidebar/Instructions/HeadlessInstructionSync.tsx',
);
const instructionsPath = path.join(
  repoRoot,
  'pages/content/src/components/sidebar/Instructions/instructionGeneratorJson.ts',
);

const [headless, instructions] = await Promise.all([
  fs.readFile(headlessPath, 'utf8'),
  fs.readFile(instructionsPath, 'utf8'),
]);

assert.match(
  headless,
  /type:\s*'mcp:call-tool'[\s\S]{0,240}?toolName:\s*REVIEW_REQUEST_TOOL[\s\S]{0,160}?args:\s*\{\}/,
  'observed request_code_review_access calls must execute through the official mcp:call-tool path',
);

assert.match(
  headless,
  /if \(!containsReviewRequestCall\(source\.textContent \|\| ''\)\) return;[\s\S]{0,700}?void executeObservedReviewRequest\(source\)/,
  'only a parsed, real model function call may create the Pending Request',
);

assert.match(
  headless,
  /const originSession = response\.originSession \|\| null;/,
  'tool capability state must be driven by originSession, not a globally visible fallback session',
);

assert.match(
  headless,
  /const toolScopeMismatch = originSession \? !hasReadTools : !hasRequestTool;/,
  'a tab without its own session must retain only the access-request tool even when another chat has an active session',
);

assert.doesNotMatch(
  headless,
  /if \(session && !sessionIsForThisTab\)/,
  'a globally visible session must never clear another chat tool state',
);

assert.match(
  headless,
  /function pendingRequestId\([\s\S]*?request\.requestId \|\| request\.id/,
  'requestId must be authoritative while preserving the temporary compatibility alias',
);

assert.match(
  instructions,
  /template below is intentionally NOT valid JSON/,
  'the instruction example must stay non-executable so inserting MCP instructions alone cannot create access requests',
);

console.log('✓ Real DOM request call creates Pending independently of general Auto Execute');
console.log('✓ Origin session, not global visibility, controls the per-tab tool set');
console.log('✓ Instruction template remains intentionally non-executable');
