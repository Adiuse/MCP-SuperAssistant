import { createLogger } from '@extension/shared/lib/logger';
import { notifyCodeReviewDenied } from './codeReviewNotifications.js';

const logger = createLogger('CodeReviewGate');

const SESSION_STORAGE_KEY = 'mcpCodeReviewSession';
const PENDING_STORAGE_KEY = 'mcpCodeReviewPendingRequest';
const AUDIT_STORAGE_KEY = 'mcpCodeReviewAuditLog';
const MAX_AUDIT_ENTRIES = 500;

export const CODE_REVIEW_REQUEST_TOOL_NAME = 'request_code_review_access';
export const CODE_REVIEW_ALLOWED_DURATIONS = [5, 10, 20] as const;
export type CodeReviewDurationMinutes = (typeof CODE_REVIEW_ALLOWED_DURATIONS)[number];

export const CODE_REVIEW_ALLOWED_TOOLS = [
  'get_me',
  'get_file_contents',
  'get_repository_tree',
  'search_code',
  'list_commits',
  'get_commit',
  'get_file_blame',
  'list_branches',
  'list_tags',
  'get_tag',
  'list_pull_requests',
  'pull_request_read',
] as const;

const ALLOWED_TOOL_SET = new Set<string>(CODE_REVIEW_ALLOWED_TOOLS);
const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const REPO_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;

const REPO_SCOPED_TOOLS = new Set<string>([
  'get_file_contents',
  'get_repository_tree',
  'list_commits',
  'get_commit',
  'get_file_blame',
  'list_branches',
  'list_tags',
  'get_tag',
  'list_pull_requests',
  'pull_request_read',
]);

const SEARCH_QUERY_TOOLS = new Set<string>(['search_code']);

const MAX_TOOL_CALLS_PER_SESSION = 200;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_RESPONSE_BYTES = 25 * 1024 * 1024;

export interface CodeReviewSession {
  id: string;
  mode: 'code_review';
  owner: string;
  repo: string;
  approvedTabId: number;
  startedAt: number;
  expiresAt: number;
  durationMinutes: CodeReviewDurationMinutes;
  callCount: number;
  responseBytes: number;
  allowedTools: string[];
}

export interface PendingCodeReviewRequest {
  id: string;
  owner: string;
  repo: string;
  durationMinutes: CodeReviewDurationMinutes;
  requestedAt: number;
}

export type CodeReviewAuditAction =
  | 'access_requested'
  | 'access_rejected'
  | 'session_started'
  | 'session_revoked'
  | 'session_expired'
  | 'tool_allowed'
  | 'tool_denied'
  | 'response_allowed'
  | 'response_denied'
  | 'notification_sent'
  | 'notification_failed';

export interface CodeReviewAuditEntry {
  timestamp: number;
  action: CodeReviewAuditAction;
  sessionId?: string;
  toolName?: string;
  owner?: string;
  repo?: string;
  reason?: string;
  tabId?: number;
  responseBytes?: number;
  argKeys?: string[];
  resource?: string;
}

let operationQueue: Promise<void> = Promise.resolve();

function withGateLock<T>(operation: () => Promise<T>): Promise<T> {
  const run = operationQueue.then(operation, operation);
  operationQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function normalizePart(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function createId(prefix: string): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function validateRepository(ownerInput: unknown, repoInput: unknown): { owner: string; repo: string } {
  const owner = typeof ownerInput === 'string' ? ownerInput.trim() : '';
  const repo = typeof repoInput === 'string' ? repoInput.trim() : '';

  if (!OWNER_PATTERN.test(owner)) {
    throw new Error('GitHub owner is invalid');
  }
  if (!REPO_PATTERN.test(repo) || repo === '.' || repo === '..') {
    throw new Error('GitHub repository name is invalid');
  }
  return { owner, repo };
}

function validateDuration(value: unknown): CodeReviewDurationMinutes {
  const duration = Number(value);
  if (!CODE_REVIEW_ALLOWED_DURATIONS.includes(duration as CodeReviewDurationMinutes)) {
    throw new Error(`Duration must be one of: ${CODE_REVIEW_ALLOWED_DURATIONS.join(', ')} minutes`);
  }
  return duration as CodeReviewDurationMinutes;
}

function extractSafeResource(args: Record<string, any>): string | undefined {
  const path = typeof args?.path === 'string' ? args.path.trim() : '';
  if (!path) return undefined;
  const sanitized = path.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 300);
  return sanitized || undefined;
}

async function appendAuditLog(entry: CodeReviewAuditEntry): Promise<void> {
  try {
    const stored = await chrome.storage.local.get(AUDIT_STORAGE_KEY);
    const current = Array.isArray(stored[AUDIT_STORAGE_KEY]) ? stored[AUDIT_STORAGE_KEY] : [];
    const next = [...current, entry].slice(-MAX_AUDIT_ENTRIES);
    await chrome.storage.local.set({ [AUDIT_STORAGE_KEY]: next });
  } catch (error) {
    logger.warn('[CodeReviewGate] Failed to persist audit entry:', error);
  }
}

export async function recordCodeReviewAuditEvent(entry: CodeReviewAuditEntry): Promise<void> {
  await withGateLock(() => appendAuditLog(entry));
}

export async function recordCodeReviewAccessRequest(input: {
  owner: string;
  repo: string;
  durationMinutes: number;
  tabId?: number;
}): Promise<void> {
  await recordCodeReviewAuditEvent({
    timestamp: Date.now(),
    action: 'access_requested',
    owner: input.owner.trim(),
    repo: input.repo.trim(),
    tabId: input.tabId,
    reason: `${input.durationMinutes} minute read-only Code Review request`,
  });
}

export async function clearCodeReviewAuditLog(): Promise<void> {
  await withGateLock(async () => {
    await chrome.storage.local.remove(AUDIT_STORAGE_KEY);
  });
}

async function loadStoredSession(): Promise<CodeReviewSession | null> {
  const stored = await chrome.storage.local.get(SESSION_STORAGE_KEY);
  return (stored[SESSION_STORAGE_KEY] as CodeReviewSession | undefined) || null;
}

async function loadPendingRequest(): Promise<PendingCodeReviewRequest | null> {
  const stored = await chrome.storage.local.get(PENDING_STORAGE_KEY);
  return (stored[PENDING_STORAGE_KEY] as PendingCodeReviewRequest | undefined) || null;
}

async function removeStoredSession(): Promise<void> {
  await chrome.storage.local.remove(SESSION_STORAGE_KEY);
}

async function removePendingRequest(): Promise<void> {
  await chrome.storage.local.remove(PENDING_STORAGE_KEY);
}

async function getActiveSessionUnlocked(): Promise<CodeReviewSession | null> {
  const session = await loadStoredSession();
  if (!session) return null;

  if (Date.now() >= session.expiresAt) {
    await removeStoredSession();
    await appendAuditLog({
      timestamp: Date.now(),
      action: 'session_expired',
      sessionId: session.id,
      owner: session.owner,
      repo: session.repo,
      tabId: session.approvedTabId,
    });
    return null;
  }

  return session;
}

export async function getActiveCodeReviewSession(): Promise<CodeReviewSession | null> {
  return withGateLock(() => getActiveSessionUnlocked());
}

export async function getPendingCodeReviewRequest(): Promise<PendingCodeReviewRequest | null> {
  return withGateLock(() => loadPendingRequest());
}

export async function createPendingCodeReviewRequest(input: {
  owner: unknown;
  repo: unknown;
  durationMinutes: unknown;
}): Promise<PendingCodeReviewRequest> {
  return withGateLock(async () => {
    const active = await getActiveSessionUnlocked();
    if (active) {
      throw new Error(`A Code Review session is already active for ${active.owner}/${active.repo}`);
    }

    const { owner, repo } = validateRepository(input.owner, input.repo);
    const durationMinutes = validateDuration(input.durationMinutes);
    const existing = await loadPendingRequest();

    if (existing) {
      if (
        normalizePart(existing.owner) === normalizePart(owner) &&
        normalizePart(existing.repo) === normalizePart(repo) &&
        existing.durationMinutes === durationMinutes
      ) {
        return existing;
      }
      throw new Error(`Another access request is already waiting for approval: ${existing.owner}/${existing.repo}`);
    }

    const request: PendingCodeReviewRequest = {
      id: createId('request'),
      owner,
      repo,
      durationMinutes,
      requestedAt: Date.now(),
    };

    await chrome.storage.local.set({ [PENDING_STORAGE_KEY]: request });
    await appendAuditLog({
      timestamp: request.requestedAt,
      action: 'access_requested',
      owner,
      repo,
      reason: `${durationMinutes} minute read-only Code Review request generated by AI`,
    });

    return request;
  });
}

export async function rejectPendingCodeReviewRequest(reason = 'rejected by user'): Promise<PendingCodeReviewRequest | null> {
  return withGateLock(async () => {
    const pending = await loadPendingRequest();
    await removePendingRequest();
    if (pending) {
      await appendAuditLog({
        timestamp: Date.now(),
        action: 'access_rejected',
        owner: pending.owner,
        repo: pending.repo,
        reason,
      });
    }
    return pending;
  });
}

export async function startCodeReviewSession(input: {
  owner: string;
  repo: string;
  durationMinutes: number;
  approvedTabId: number;
}): Promise<CodeReviewSession> {
  return withGateLock(async () => {
    const { owner, repo } = validateRepository(input.owner, input.repo);
    const durationMinutes = validateDuration(input.durationMinutes);

    if (!Number.isInteger(input.approvedTabId) || input.approvedTabId < 0) {
      throw new Error('A valid browser tab is required to approve code review access');
    }

    const now = Date.now();
    const session: CodeReviewSession = {
      id: createId('review'),
      mode: 'code_review',
      owner,
      repo,
      approvedTabId: input.approvedTabId,
      startedAt: now,
      expiresAt: now + durationMinutes * 60_000,
      durationMinutes,
      callCount: 0,
      responseBytes: 0,
      allowedTools: [...CODE_REVIEW_ALLOWED_TOOLS],
    };

    await chrome.storage.local.set({ [SESSION_STORAGE_KEY]: session });
    await removePendingRequest();
    await appendAuditLog({
      timestamp: now,
      action: 'session_started',
      sessionId: session.id,
      owner,
      repo,
      tabId: input.approvedTabId,
      reason: `${durationMinutes} minute explicit approval`,
    });

    logger.debug(`[CodeReviewGate] Started code review session ${session.id} for ${owner}/${repo}`);
    return session;
  });
}

export async function revokeCodeReviewSession(reason = 'manual revoke'): Promise<CodeReviewSession | null> {
  return withGateLock(async () => {
    const session = await loadStoredSession();
    await removeStoredSession();

    await appendAuditLog({
      timestamp: Date.now(),
      action: 'session_revoked',
      sessionId: session?.id,
      owner: session?.owner,
      repo: session?.repo,
      tabId: session?.approvedTabId,
      reason,
    });

    return session;
  });
}

export async function assertApprovedTab(tabId: number | undefined): Promise<CodeReviewSession> {
  return withGateLock(async () => {
    const session = await getActiveSessionUnlocked();
    if (!session) {
      throw new Error('Code review access is OFF. Explicit approval is required.');
    }

    if (tabId === undefined || session.approvedTabId !== tabId) {
      const reason = 'request came from a tab that was not explicitly approved';
      await appendAuditLog({
        timestamp: Date.now(),
        action: 'tool_denied',
        sessionId: session.id,
        owner: session.owner,
        repo: session.repo,
        tabId,
        reason,
      });
      await notifyCodeReviewDenied('tab_scope', reason);
      throw new Error('This Code Review session is locked to the browser tab that approved it.');
    }

    return session;
  });
}

function sanitizeSearchCodeQuery(query: unknown, session: CodeReviewSession): string {
  if (typeof query !== 'string' || !query.trim()) {
    throw new Error('search_code requires a non-empty query');
  }

  if (/\b(?:repo|org|user):/i.test(query)) {
    throw new Error('Repository/org/user scope qualifiers are managed by the Code Review gate');
  }

  if (/\bOR\b/i.test(query)) {
    throw new Error('OR queries are disabled in gated Code Review search; use separate searches instead');
  }

  return `${query.trim()} repo:${session.owner}/${session.repo}`;
}

function enforceRepoScope(
  toolName: string,
  args: Record<string, any>,
  session: CodeReviewSession,
): Record<string, any> {
  const nextArgs = { ...args };

  if (SEARCH_QUERY_TOOLS.has(toolName)) {
    nextArgs.query = sanitizeSearchCodeQuery(nextArgs.query, session);
    return nextArgs;
  }

  if (!REPO_SCOPED_TOOLS.has(toolName)) return nextArgs;

  const requestedOwner = normalizePart(nextArgs.owner);
  const requestedRepo = normalizePart(nextArgs.repo);
  const allowedOwner = normalizePart(session.owner);
  const allowedRepo = normalizePart(session.repo);

  if (requestedOwner && requestedOwner !== allowedOwner) {
    throw new Error(`Repository scope violation: owner '${nextArgs.owner}' is not approved`);
  }

  if (requestedRepo && requestedRepo !== allowedRepo) {
    throw new Error(`Repository scope violation: repo '${nextArgs.repo}' is not approved`);
  }

  nextArgs.owner = session.owner;
  nextArgs.repo = session.repo;
  return nextArgs;
}

export async function authorizeCodeReviewToolCall(
  toolName: string,
  args: Record<string, any>,
): Promise<Record<string, any>> {
  return withGateLock(async () => {
    const session = await getActiveSessionUnlocked();
    const argKeys = Object.keys(args || {}).sort();
    const resource = extractSafeResource(args || {});

    if (!session) {
      const reason = 'no active code review session';
      await appendAuditLog({ timestamp: Date.now(), action: 'tool_denied', toolName, argKeys, resource, reason });
      await notifyCodeReviewDenied(toolName, reason);
      throw new Error('Code review access is OFF. Explicit approval is required.');
    }

    if (!ALLOWED_TOOL_SET.has(toolName)) {
      const reason = 'tool is not in the code review allowlist';
      await appendAuditLog({
        timestamp: Date.now(),
        action: 'tool_denied',
        sessionId: session.id,
        toolName,
        owner: session.owner,
        repo: session.repo,
        tabId: session.approvedTabId,
        argKeys,
        resource,
        reason,
      });
      await notifyCodeReviewDenied(toolName, reason);
      throw new Error(`Tool '${toolName}' is blocked by Code Review policy`);
    }

    if (session.callCount >= MAX_TOOL_CALLS_PER_SESSION) {
      const reason = 'session tool-call limit reached; session revoked';
      await removeStoredSession();
      await appendAuditLog({
        timestamp: Date.now(), action: 'tool_denied', sessionId: session.id, toolName,
        owner: session.owner, repo: session.repo, argKeys, resource, reason,
      });
      await notifyCodeReviewDenied(toolName, reason);
      throw new Error('Code Review call limit reached. The session has been revoked.');
    }

    let sanitizedArgs: Record<string, any>;
    try {
      sanitizedArgs = enforceRepoScope(toolName, args || {}, session);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await appendAuditLog({
        timestamp: Date.now(), action: 'tool_denied', sessionId: session.id, toolName,
        owner: session.owner, repo: session.repo, tabId: session.approvedTabId,
        argKeys, resource, reason,
      });
      await notifyCodeReviewDenied(toolName, reason);
      throw error;
    }

    await chrome.storage.local.set({
      [SESSION_STORAGE_KEY]: { ...session, callCount: session.callCount + 1 },
    });

    await appendAuditLog({
      timestamp: Date.now(), action: 'tool_allowed', sessionId: session.id, toolName,
      owner: session.owner, repo: session.repo, tabId: session.approvedTabId, argKeys, resource,
    });

    return sanitizedArgs;
  });
}

export async function enforceCodeReviewResultPolicy(toolName: string, result: any): Promise<any> {
  const serialized = JSON.stringify(result ?? null);
  const responseBytes = new TextEncoder().encode(serialized).byteLength;

  return withGateLock(async () => {
    const session = await getActiveSessionUnlocked();
    if (!session) {
      throw new Error('Code Review session expired before the tool result could be returned');
    }

    if (responseBytes > MAX_RESPONSE_BYTES) {
      const reason = `single response exceeded ${MAX_RESPONSE_BYTES} bytes`;
      await appendAuditLog({
        timestamp: Date.now(), action: 'response_denied', sessionId: session.id, toolName,
        owner: session.owner, repo: session.repo, responseBytes, reason,
      });
      await notifyCodeReviewDenied(toolName, reason);
      throw new Error('Tool result is too large for gated Code Review. Request a narrower file/range/query.');
    }

    const nextTotal = session.responseBytes + responseBytes;
    if (nextTotal > MAX_TOTAL_RESPONSE_BYTES) {
      const reason = 'session response-byte limit reached; session revoked';
      await removeStoredSession();
      await appendAuditLog({
        timestamp: Date.now(), action: 'response_denied', sessionId: session.id, toolName,
        owner: session.owner, repo: session.repo, responseBytes, reason,
      });
      await notifyCodeReviewDenied(toolName, reason);
      throw new Error('Code Review data limit reached. The session has been revoked.');
    }

    await chrome.storage.local.set({
      [SESSION_STORAGE_KEY]: { ...session, responseBytes: nextTotal },
    });

    await appendAuditLog({
      timestamp: Date.now(), action: 'response_allowed', sessionId: session.id, toolName,
      owner: session.owner, repo: session.repo, responseBytes,
    });

    return result;
  });
}

export async function filterCodeReviewTools<T extends { name: string }>(tools: T[]): Promise<T[]> {
  const session = await getActiveCodeReviewSession();
  if (!session) return [];
  return tools.filter(tool => ALLOWED_TOOL_SET.has(tool.name));
}

export function getCodeReviewRequestTool() {
  return {
    name: CODE_REVIEW_REQUEST_TOOL_NAME,
    description:
      'Request temporary read-only GitHub Code Review access from the user. Use this BEFORE attempting any GitHub repository read when no review session is active. This tool does not access GitHub; it only opens an approval request in the local security panel. After the user approves, continue with the GitHub read-only tools.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: {
          type: 'string',
          description: 'Exact GitHub repository owner or organization name, for example Adiuse',
        },
        repo: {
          type: 'string',
          description: 'Exact GitHub repository name, for example MCP-SuperAssistant',
        },
        durationMinutes: {
          type: 'integer',
          enum: [5, 10, 20],
          description: 'Requested temporary access duration in minutes. Prefer 5 unless more time is clearly needed.',
        },
      },
      required: ['owner', 'repo', 'durationMinutes'],
      additionalProperties: false,
    },
  };
}

export async function getCodeReviewAuditLog(): Promise<CodeReviewAuditEntry[]> {
  const stored = await chrome.storage.local.get(AUDIT_STORAGE_KEY);
  return Array.isArray(stored[AUDIT_STORAGE_KEY]) ? stored[AUDIT_STORAGE_KEY] : [];
}
