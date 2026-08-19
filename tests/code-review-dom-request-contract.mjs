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
  headless,
  /function currentConversationPath\(\): string \{\s*return window\.location\.pathname;\s*\}/,
  'conversation identity in HeadlessInstructionSync must be pathname-only so query/hash changes do not fork an approved origin',
);
assert.doesNotMatch(
  headless,
  /window\.location\.pathname\}\$\{window\.location\.search/,
  'HeadlessInstructionSync must not include the query string in conversation identity',
);
assert.match(
  headless,
  /This lease is bound to the real user prompt that created this review job\./,
  'approval continuation must tell the model that the lease is prompt-bound',
);
assert.match(
  headless,
  /any later ordinary user prompt requires fresh approval before further GitHub reads\./,
  'approval continuation must require fresh approval for a later real user prompt',
);
assert.doesNotMatch(
  headless,
  /Do not request access again unless this session expires or is revoked/,
  'legacy session-scoped continuation wording must not survive the prompt-bound SSOT',
);

assert.match(
  instructions,
  /template below is intentionally NOT valid JSON/,
  'the instruction example must stay non-executable so inserting MCP instructions alone cannot create access requests',
);

assert.match(
  instructions,
  /function isActiveCodeReviewToolset\(/,
  'approved read-only tool exposure must be recognized as an active Code Review continuation',
);
assert.match(
  instructions,
  /\[MCP Code Review Session Active\]\[IMPORTANT\]/,
  'approval continuation must use a compact active-session instruction block instead of repeating the initial MCP block',
);
assert.match(
  instructions,
  /If you receive a NEW ordinary user prompt\/message after this approval/,
  'active instructions must explicitly separate a new real user prompt from internal tool-result continuation',
);
assert.match(
  instructions,
  /A later ordinary user prompt requires a new approval before any new GitHub read\./,
  'active instructions must preserve the prompt-bound approval rule through the whole tool loop',
);
assert.match(
  instructions,
  /if \(isActiveCodeReviewToolset\(tools\)\) \{[\s\S]{0,120}?return generateActiveCodeReviewInstructions\(toolList\);/,
  'the compact continuation must be selected automatically after approval exposes the read-only tool set',
);

console.log('✓ Real DOM request call creates Pending independently of general Auto Execute');
console.log('✓ Origin session, not global visibility, controls the per-tab tool set');
console.log('✓ Headless conversation identity is pathname-only and approval continuation is prompt-bound');
console.log('✓ Instruction template remains intentionally non-executable');
console.log('✓ Approved Code Review resumes with a compact prompt-bound tool delta instead of duplicating the full initial instructions');
