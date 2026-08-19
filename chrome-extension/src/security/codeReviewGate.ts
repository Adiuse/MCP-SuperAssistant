import { createLogger } from '@extension/shared/lib/logger';

const logger = createLogger('CodeReviewGate');

const LEGACY_SESSION_STORAGE_KEY = 'mcpCodeReviewSession';
const SESSIONS_STORAGE_KEY = 'mcpCodeReviewSessions';
const PENDING_STORAGE_KEY = 'mcpCodeReviewPendingRequest';
const PREFERENCES_STORAGE_KEY = 'mcpCodeReviewPreferences';
const AUDIT_STORAGE_KEY = 'mcpCodeReviewAuditLog';
const USER_TURNS_STORAGE_KEY = 'mcpCodeReviewUserTurns';
const MAX_AUDIT_ENTRIES = 500;
const MAX_PENDING_REQUESTS = 100;
const MAX_USER_TURNS = 200;

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

export const CODE_REVIEW_MAX_TOOL_CALLS = 200;
export const CODE_REVIEW_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
export const CODE_REVIEW_MAX_SESSION_BYTES = 25 * 1024 * 1024;

export interface CodeReviewPreferences {
  owner: string;
  repo: string;
  durationMinutes: CodeReviewDurationMinutes;
  updatedAt: number;
}

export interface CodeReviewUserTurn {
  id: string;
  sourceTabId: number;
  sourcePath: string;
  startedAt: number;
  clientSubmissionId?: string;
}

export interface CodeReviewSession {
  id: string;
  mode: 'code_review';
  owner: string;
  repo: string;
  approvedTabId: number;
  sourceKey: string;
  sourcePath: string;
  sourceRequestId: string;
  jobId: string;
  userTurnId: string;
  capabilityId: string;
  startedAt: number;
  expiresAt: number;
  durationMinutes: CodeReviewDurationMinutes;
  callCount: number;
  responseBytes: number;
  allowedTools: string[];
}

export interface PendingCodeReviewRequest {
  requestId: string;
  owner: string;
  repo: string;
  durationMinutes: CodeReviewDurationMinutes;
  requestedAt: number;
  sourceKey: string;
  sourcePath: string;
  sourceTabId: number;
  jobId: string;
  userTurnId: string;
}

export type CodeReviewAuditAction =
  | 'access_requested'
  | 'access_approved'
  | 'access_rejected'
  | 'session_started'
  | 'session_revoked'
  | 'session_expired'
  | 'job_started'
  | 'job_revoked'
  | 'job_expired'
  | 'new_user_turn_invalidated_old_job'
  | 'tool_allowed'
  | 'tool_denied'
  | 'response_allowed'
  | 'response_denied'
  | 'scope_violation'
  | 'notification_sent'
  | 'notification_failed';

export interface CodeReviewAuditEntry {
  timestamp: number;
  action: CodeReviewAuditAction;
  requestId?: string;
  sessionId?: string;
  jobId?: string;
  userTurnId?: string;
  capabilityId?: string;
  toolName?: string;
  owner?: string;
  repo?: string;
  reason?: string;
  tabId?: number;
  actorTabId?: number;
  originTabId?: number;
  sourcePath?: string;
  responseBytes?: number;
  argKeys?: string[];
  resource?: string;
}

export interface AuthorizedCodeReviewToolCall {
  args: Record<string, any>;
  sessionId: string;
  jobId: string;
  userTurnId: string;
  capabilityId: string;
}

export interface RegisterUserTurnResult {
  userTurn: CodeReviewUserTurn;
  invalidatedSessions: CodeReviewSession[];
  invalidatedRequests: PendingCodeReviewRequest[];
  deduplicated: boolean;
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
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function validateRepository(ownerInput: unknown, repoInput: unknown): { owner: string; repo: string } {
  const owner = typeof ownerInput === 'string' ? ownerInput.trim() : '';
  const repo = typeof repoInput === 'string' ? repoInput.trim() : '';
  if (!OWNER_PATTERN.test(owner)) throw new Error('GitHub owner is invalid');
  if (!REPO_PATTERN.test(repo) || repo === '.' || repo === '..') throw new Error('GitHub repository name is invalid');
  return { owner, repo };
}

function validateDuration(value: unknown): CodeReviewDurationMinutes {
  const duration = Number(value);
  if (!CODE_REVIEW_ALLOWED_DURATIONS.includes(duration as CodeReviewDurationMinutes)) {
    throw new Error(`Duration must be one of: ${CODE_REVIEW_ALLOWED_DURATIONS.join(', ')} minutes`);
  }
  return duration as CodeReviewDurationMinutes;
}

function sanitizeOptionalString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, maxLength);
  return clean || undefined;
}

function sanitizeRequiredString(value: unknown, maxLength: number, label: string): string {
  const clean = sanitizeOptionalString(value, maxLength);
  if (!clean) throw new Error(`${label} is required`);
  return clean;
}

function sanitizeTabId(value: unknown): number | undefined {
  const tabId = Number(value);
  return Number.isInteger(tabId) && tabId >= 0 ? tabId : undefined;
}

export function sourcePathFromUrl(url?: string): string | undefined {
  if (!url) return undefined;
  if (url.startsWith('/')) {
    const queryIndex = url.indexOf('?');
    const hashIndex = url.indexOf('#');
    const cutAt = [queryIndex, hashIndex]
      .filter(index => index >= 0)
      .reduce((lowest, index) => Math.min(lowest, index), url.length);
    return sanitizeOptionalString(url.slice(0, cutAt), 500);
  }
  try {
    return sanitizeOptionalString(new URL(url).pathname, 500);
  } catch {
    return undefined;
  }
}

function sameOrigin(tabId: number, sourcePath: string, candidateTabId: number, candidatePath?: string): boolean {
  return tabId === candidateTabId && sourcePath === candidatePath;
}

function extractSafeResource(args: Record<string, any>): string | undefined {
  const path = typeof args?.path === 'string' ? args.path.trim() : '';
  if (!path) return undefined;
  return path.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 300) || undefined;
}

async function appendAuditLog(entry: CodeReviewAuditEntry): Promise<void> {
  try {
    const stored = await chrome.storage.local.get(AUDIT_STORAGE_KEY);
    const current = Array.isArray(stored[AUDIT_STORAGE_KEY]) ? stored[AUDIT_STORAGE_KEY] : [];
    await chrome.storage.local.set({ [AUDIT_STORAGE_KEY]: [...current, entry].slice(-MAX_AUDIT_ENTRIES) });
  } catch (error) {
    logger.warn('[CodeReviewGate] Failed to persist audit entry:', error);
  }
}

export async function recordCodeReviewAuditEvent(entry: CodeReviewAuditEntry): Promise<void> {
  await withGateLock(() => appendAuditLog(entry));
}

export async function clearCodeReviewAuditLog(): Promise<void> {
  await withGateLock(() => chrome.storage.local.remove(AUDIT_STORAGE_KEY));
}

async function loadStoredPreferences(): Promise<CodeReviewPreferences | null> {
  const stored = await chrome.storage.local.get(PREFERENCES_STORAGE_KEY);
  const raw = stored[PREFERENCES_STORAGE_KEY] as Partial<CodeReviewPreferences> | undefined;
  if (!raw) return null;
  try {
    const { owner, repo } = validateRepository(raw.owner, raw.repo);
    const durationMinutes = validateDuration(raw.durationMinutes);
    return { owner, repo, durationMinutes, updatedAt: Number(raw.updatedAt) || Date.now() };
  } catch {
    return null;
  }
}

export async function getCodeReviewPreferences(): Promise<CodeReviewPreferences | null> {
  return withGateLock(() => loadStoredPreferences());
}

export async function saveCodeReviewPreferences(input: {
  owner: unknown;
  repo: unknown;
  durationMinutes: unknown;
}): Promise<CodeReviewPreferences> {
  return withGateLock(async () => {
    const { owner, repo } = validateRepository(input.owner, input.repo);
    const durationMinutes = validateDuration(input.durationMinutes);
    const preferences = { owner, repo, durationMinutes, updatedAt: Date.now() };
    await chrome.storage.local.set({ [PREFERENCES_STORAGE_KEY]: preferences });
    return preferences;
  });
}

function normalizeUserTurn(raw: any): CodeReviewUserTurn | null {
  if (!raw || typeof raw !== 'object') return null;
  const sourceTabId = sanitizeTabId(raw.sourceTabId);
  const sourcePath = sourcePathFromUrl(raw.sourcePath);
  const id = sanitizeOptionalString(raw.id, 200);
  if (sourceTabId === undefined || !sourcePath || !id) return null;
  return {
    id,
    sourceTabId,
    sourcePath,
    startedAt: Number(raw.startedAt) || Date.now(),
    clientSubmissionId: sanitizeOptionalString(raw.clientSubmissionId, 200),
  };
}

async function loadUserTurns(): Promise<CodeReviewUserTurn[]> {
  const stored = await chrome.storage.local.get(USER_TURNS_STORAGE_KEY);
  const raw = stored[USER_TURNS_STORAGE_KEY];
  return (Array.isArray(raw) ? raw : []).map(normalizeUserTurn).filter(Boolean) as CodeReviewUserTurn[];
}

async function saveUserTurns(turns: CodeReviewUserTurn[]): Promise<void> {
  await chrome.storage.local.set({ [USER_TURNS_STORAGE_KEY]: turns.slice(-MAX_USER_TURNS) });
}

async function getCurrentUserTurnForOriginUnlocked(
  tabId: number | undefined,
  sourceUrl?: string,
): Promise<CodeReviewUserTurn | null> {
  const sourcePath = sourcePathFromUrl(sourceUrl);
  if (tabId === undefined || !sourcePath) return null;
  const turns = await loadUserTurns();
  return [...turns].reverse().find(turn => sameOrigin(tabId, sourcePath, turn.sourceTabId, turn.sourcePath)) || null;
}

export async function getCurrentCodeReviewUserTurnForOrigin(
  tabId: number | undefined,
  sourceUrl?: string,
): Promise<CodeReviewUserTurn | null> {
  return withGateLock(() => getCurrentUserTurnForOriginUnlocked(tabId, sourceUrl));
}

function normalizeStoredSession(raw: any): CodeReviewSession | null {
  if (!raw || typeof raw !== 'object') return null;
  const approvedTabId = sanitizeTabId(raw.approvedTabId);
  const sourcePath = sourcePathFromUrl(raw.sourcePath);
  if (approvedTabId === undefined || !sourcePath) return null;
  try {
    const { owner, repo } = validateRepository(raw.owner, raw.repo);
    const durationMinutes = validateDuration(raw.durationMinutes);
    const id = sanitizeRequiredString(raw.id, 200, 'sessionId');
    const sourceRequestId = sanitizeRequiredString(raw.sourceRequestId ?? raw.requestId, 200, 'sourceRequestId');
    const jobId = sanitizeOptionalString(raw.jobId, 200);
    const userTurnId = sanitizeOptionalString(raw.userTurnId, 200);
    const capabilityId = sanitizeOptionalString(raw.capabilityId, 200);
    // Legacy chat-scoped sessions are intentionally dropped on upgrade. They do
    // not satisfy the prompt-bound SSOT and must fail closed.
    if (!jobId || !userTurnId || !capabilityId) return null;
    return {
      id,
      mode: 'code_review',
      owner,
      repo,
      approvedTabId,
      sourceKey: sanitizeOptionalString(raw.sourceKey, 700) || `${approvedTabId}:${sourcePath}:${userTurnId}`,
      sourcePath,
      sourceRequestId,
      jobId,
      userTurnId,
      capabilityId,
      startedAt: Number(raw.startedAt) || Date.now(),
      expiresAt: Number(raw.expiresAt) || 0,
      durationMinutes,
      callCount: Math.max(0, Number(raw.callCount) || 0),
      responseBytes: Math.max(0, Number(raw.responseBytes) || 0),
      allowedTools: [...CODE_REVIEW_ALLOWED_TOOLS],
    };
  } catch {
    return null;
  }
}

async function loadStoredSessions(): Promise<CodeReviewSession[]> {
  const stored = await chrome.storage.local.get([SESSIONS_STORAGE_KEY, LEGACY_SESSION_STORAGE_KEY]);
  const rawSessions = stored[SESSIONS_STORAGE_KEY];
  const normalized = Array.isArray(rawSessions)
    ? (rawSessions.map(normalizeStoredSession).filter(Boolean) as CodeReviewSession[])
    : [];
  // Never migrate a legacy session lacking prompt binding. Remove it instead.
  if (stored[LEGACY_SESSION_STORAGE_KEY]) await chrome.storage.local.remove(LEGACY_SESSION_STORAGE_KEY);
  if (Array.isArray(rawSessions) && normalized.length !== rawSessions.length) await saveStoredSessions(normalized);
  return normalized;
}

async function saveStoredSessions(sessions: CodeReviewSession[]): Promise<void> {
  if (sessions.length === 0) {
    await chrome.storage.local.remove([SESSIONS_STORAGE_KEY, LEGACY_SESSION_STORAGE_KEY]);
    return;
  }
  await chrome.storage.local.set({ [SESSIONS_STORAGE_KEY]: sessions });
  await chrome.storage.local.remove(LEGACY_SESSION_STORAGE_KEY);
}

function normalizePendingRequest(raw: any): PendingCodeReviewRequest | null {
  if (!raw || typeof raw !== 'object') return null;
  const sourceTabId = sanitizeTabId(raw.sourceTabId);
  const sourcePath = sourcePathFromUrl(raw.sourcePath);
  if (sourceTabId === undefined || !sourcePath) return null;
  try {
    const { owner, repo } = validateRepository(raw.owner, raw.repo);
    const durationMinutes = validateDuration(raw.durationMinutes);
    const requestId = sanitizeRequiredString(raw.requestId ?? raw.id, 200, 'requestId');
    const jobId = sanitizeOptionalString(raw.jobId, 200);
    const userTurnId = sanitizeOptionalString(raw.userTurnId, 200);
    if (!jobId || !userTurnId) return null;
    return {
      requestId,
      owner,
      repo,
      durationMinutes,
      requestedAt: Number(raw.requestedAt) || Date.now(),
      sourceKey: sanitizeOptionalString(raw.sourceKey, 700) || `${sourceTabId}:${sourcePath}:${userTurnId}`,
      sourcePath,
      sourceTabId,
      jobId,
      userTurnId,
    };
  } catch {
    return null;
  }
}

async function loadPendingRequests(): Promise<PendingCodeReviewRequest[]> {
  const stored = await chrome.storage.local.get(PENDING_STORAGE_KEY);
  const raw = stored[PENDING_STORAGE_KEY];
  const items = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? [raw] : [];
  const normalized = items.map(normalizePendingRequest).filter(Boolean) as PendingCodeReviewRequest[];
  if (items.length !== normalized.length) await savePendingRequests(normalized);
  return normalized;
}

async function savePendingRequests(requests: PendingCodeReviewRequest[]): Promise<void> {
  if (requests.length === 0) {
    await chrome.storage.local.remove(PENDING_STORAGE_KEY);
    return;
  }
  await chrome.storage.local.set({ [PENDING_STORAGE_KEY]: requests.slice(-MAX_PENDING_REQUESTS) });
}

async function cleanupExpiredSessionsUnlocked(): Promise<CodeReviewSession[]> {
  const sessions = await loadStoredSessions();
  const now = Date.now();
  const active = sessions.filter(session => now < session.expiresAt);
  const expired = sessions.filter(session => now >= session.expiresAt);
  if (expired.length > 0) {
    await saveStoredSessions(active);
    for (const session of expired) {
      const base = {
        timestamp: now,
        requestId: session.sourceRequestId,
        sessionId: session.id,
        jobId: session.jobId,
        userTurnId: session.userTurnId,
        capabilityId: session.capabilityId,
        owner: session.owner,
        repo: session.repo,
        tabId: session.approvedTabId,
        originTabId: session.approvedTabId,
        sourcePath: session.sourcePath,
        reason: 'temporary Code Review lease reached its configured expiration time',
      };
      await appendAuditLog({ ...base, action: 'session_expired' });
      await appendAuditLog({ ...base, action: 'job_expired' });
    }
  }
  return active;
}

function originMatches(session: CodeReviewSession, tabId: number | undefined, sourceUrl?: string): boolean {
  const sourcePath = sourcePathFromUrl(sourceUrl);
  return tabId !== undefined && !!sourcePath && sameOrigin(tabId, sourcePath, session.approvedTabId, session.sourcePath);
}

async function sessionMatchesCurrentTurnUnlocked(session: CodeReviewSession): Promise<boolean> {
  const current = await getCurrentUserTurnForOriginUnlocked(session.approvedTabId, session.sourcePath);
  return current?.id === session.userTurnId;
}

async function getActiveSessionForOriginUnlocked(
  tabId: number | undefined,
  sourceUrl?: string,
): Promise<CodeReviewSession | null> {
  const sessions = await cleanupExpiredSessionsUnlocked();
  const session = sessions.find(item => originMatches(item, tabId, sourceUrl)) || null;
  if (!session) return null;
  return (await sessionMatchesCurrentTurnUnlocked(session)) ? session : null;
}

export async function registerCodeReviewUserTurn(input: {
  sourceTabId?: unknown;
  sourceUrl?: unknown;
  clientSubmissionId?: unknown;
}): Promise<RegisterUserTurnResult> {
  return withGateLock(async () => {
    const sourceTabId = sanitizeTabId(input.sourceTabId);
    const sourcePath = sourcePathFromUrl(typeof input.sourceUrl === 'string' ? input.sourceUrl : undefined);
    const clientSubmissionId = sanitizeOptionalString(input.clientSubmissionId, 200);
    if (sourceTabId === undefined || !sourcePath) {
      throw new Error('Real user turns require a trusted tab and conversation pathname.');
    }

    const turns = await loadUserTurns();
    const current = [...turns]
      .reverse()
      .find(turn => sameOrigin(sourceTabId, sourcePath, turn.sourceTabId, turn.sourcePath));
    if (clientSubmissionId && current?.clientSubmissionId === clientSubmissionId) {
      return { userTurn: current, invalidatedSessions: [], invalidatedRequests: [], deduplicated: true };
    }

    const userTurn: CodeReviewUserTurn = {
      id: createId('turn'),
      sourceTabId,
      sourcePath,
      startedAt: Date.now(),
      clientSubmissionId,
    };
    await saveUserTurns([
      ...turns.filter(turn => !sameOrigin(sourceTabId, sourcePath, turn.sourceTabId, turn.sourcePath)),
      userTurn,
    ]);

    const pending = await loadPendingRequests();
    const invalidatedRequests = pending.filter(request =>
      sameOrigin(sourceTabId, sourcePath, request.sourceTabId, request.sourcePath),
    );
    if (invalidatedRequests.length > 0) {
      await savePendingRequests(pending.filter(request => !invalidatedRequests.includes(request)));
      for (const request of invalidatedRequests) {
        await appendAuditLog({
          timestamp: userTurn.startedAt,
          action: 'access_rejected',
          requestId: request.requestId,
          jobId: request.jobId,
          userTurnId: request.userTurnId,
          owner: request.owner,
          repo: request.repo,
          originTabId: request.sourceTabId,
          sourcePath: request.sourcePath,
          reason: 'superseded by a new real user prompt before approval',
        });
      }
    }

    const sessions = await cleanupExpiredSessionsUnlocked();
    const invalidatedSessions = sessions.filter(session =>
      sameOrigin(sourceTabId, sourcePath, session.approvedTabId, session.sourcePath),
    );
    if (invalidatedSessions.length > 0) {
      await saveStoredSessions(sessions.filter(session => !invalidatedSessions.includes(session)));
      for (const session of invalidatedSessions) {
        const base = {
          timestamp: userTurn.startedAt,
          requestId: session.sourceRequestId,
          sessionId: session.id,
          jobId: session.jobId,
          userTurnId: session.userTurnId,
          capabilityId: session.capabilityId,
          owner: session.owner,
          repo: session.repo,
          tabId: sourceTabId,
          originTabId: sourceTabId,
          sourcePath,
          reason: `new real user turn ${userTurn.id} invalidated the previous prompt-bound lease`,
        };
        await appendAuditLog({ ...base, action: 'new_user_turn_invalidated_old_job' });
        await appendAuditLog({ ...base, action: 'session_revoked' });
        await appendAuditLog({ ...base, action: 'job_revoked' });
      }
    }

    return { userTurn, invalidatedSessions, invalidatedRequests, deduplicated: false };
  });
}

export async function getActiveCodeReviewSessions(): Promise<CodeReviewSession[]> {
  return withGateLock(() => cleanupExpiredSessionsUnlocked());
}

export async function getActiveCodeReviewSession(): Promise<CodeReviewSession | null> {
  return withGateLock(async () => (await cleanupExpiredSessionsUnlocked())[0] || null);
}

export async function getActiveCodeReviewSessionForOrigin(
  tabId: number | undefined,
  sourceUrl?: string,
): Promise<CodeReviewSession | null> {
  return withGateLock(() => getActiveSessionForOriginUnlocked(tabId, sourceUrl));
}

export async function getPendingCodeReviewRequests(): Promise<PendingCodeReviewRequest[]> {
  return withGateLock(() => loadPendingRequests());
}

export async function getPendingCodeReviewRequest(): Promise<PendingCodeReviewRequest | null> {
  return withGateLock(async () => (await loadPendingRequests())[0] || null);
}

export async function createPendingCodeReviewRequest(input: {
  sourceKey?: unknown;
  sourcePath?: unknown;
  sourceTabId?: unknown;
}): Promise<PendingCodeReviewRequest> {
  return withGateLock(async () => {
    const preferences = await loadStoredPreferences();
    if (!preferences) throw new Error('ابتدا مخزن و مدت دسترسی را در تنظیمات Code Review ذخیره کنید.');

    const sourceTabId = sanitizeTabId(input.sourceTabId);
    const sourcePath = sourcePathFromUrl(typeof input.sourcePath === 'string' ? input.sourcePath : undefined);
    if (sourceTabId === undefined || !sourcePath) {
      throw new Error('درخواست Code Review باید به تب/گفت‌وگوی مبدأ قابل اعتماد متصل باشد.');
    }

    const currentTurn = await getCurrentUserTurnForOriginUnlocked(sourceTabId, sourcePath);
    if (!currentTurn) {
      throw new Error('هیچ Prompt واقعی کاربر برای این درخواست ثبت نشده است؛ برای امنیت درخواست رد شد.');
    }

    const activeForOrigin = await getActiveSessionForOriginUnlocked(sourceTabId, sourcePath);
    if (activeForOrigin) {
      throw new Error(`Code Review access is already active for the current prompt in ${activeForOrigin.owner}/${activeForOrigin.repo}.`);
    }

    const sourceKey = `${sourceTabId}:${sourcePath}:${currentTurn.id}`;
    const existingRequests = await loadPendingRequests();
    const existing = existingRequests.find(request => request.sourceKey === sourceKey && request.userTurnId === currentTurn.id);
    if (existing) return existing;

    const request: PendingCodeReviewRequest = {
      requestId: createId('request'),
      jobId: createId('job'),
      userTurnId: currentTurn.id,
      owner: preferences.owner,
      repo: preferences.repo,
      durationMinutes: preferences.durationMinutes,
      requestedAt: Date.now(),
      sourceKey,
      sourcePath,
      sourceTabId,
    };
    await savePendingRequests([...existingRequests, request]);
    await appendAuditLog({
      timestamp: request.requestedAt,
      action: 'access_requested',
      requestId: request.requestId,
      jobId: request.jobId,
      userTurnId: request.userTurnId,
      owner: request.owner,
      repo: request.repo,
      tabId: sourceTabId,
      originTabId: sourceTabId,
      sourcePath,
      reason: `${request.durationMinutes} minute read-only prompt-bound Code Review request`,
    });
    return request;
  });
}

export async function rejectPendingCodeReviewRequest(
  requestId: string,
  reason = 'explicitly rejected by user',
  actorTabId?: number,
): Promise<PendingCodeReviewRequest | null> {
  return withGateLock(async () => {
    const cleanRequestId = sanitizeOptionalString(requestId, 200);
    if (!cleanRequestId) throw new Error('requestId is required');
    const requests = await loadPendingRequests();
    const target = requests.find(request => request.requestId === cleanRequestId);
    if (!target) return null;
    await savePendingRequests(requests.filter(request => request.requestId !== target.requestId));
    await appendAuditLog({
      timestamp: Date.now(),
      action: 'access_rejected',
      requestId: target.requestId,
      jobId: target.jobId,
      userTurnId: target.userTurnId,
      owner: target.owner,
      repo: target.repo,
      tabId: target.sourceTabId,
      actorTabId,
      originTabId: target.sourceTabId,
      sourcePath: target.sourcePath,
      reason,
    });
    return target;
  });
}

export async function startCodeReviewSession(input: {
  requestId: string;
  approvingTabId: number;
}): Promise<CodeReviewSession> {
  return withGateLock(async () => {
    const requestId = sanitizeOptionalString(input.requestId, 200);
    const approvingTabId = sanitizeTabId(input.approvingTabId);
    if (!requestId) throw new Error('requestId is required for approval');
    if (approvingTabId === undefined) throw new Error('A valid browser tab is required to approve code review access');

    const pendingRequests = await loadPendingRequests();
    const pending = pendingRequests.find(request => request.requestId === requestId);
    if (!pending) throw new Error('The selected Code Review request is no longer pending');

    const currentTurn = await getCurrentUserTurnForOriginUnlocked(pending.sourceTabId, pending.sourcePath);
    if (!currentTurn || currentTurn.id !== pending.userTurnId) {
      await savePendingRequests(pendingRequests.filter(request => request.requestId !== pending.requestId));
      await appendAuditLog({
        timestamp: Date.now(),
        action: 'access_rejected',
        requestId: pending.requestId,
        jobId: pending.jobId,
        userTurnId: pending.userTurnId,
        owner: pending.owner,
        repo: pending.repo,
        actorTabId: approvingTabId,
        originTabId: pending.sourceTabId,
        sourcePath: pending.sourcePath,
        reason: 'approval rejected because the originating real user prompt is no longer current',
      });
      throw new Error('این درخواست متعلق به Prompt قبلی است و دیگر قابل تأیید نیست.');
    }

    const activeSessions = await cleanupExpiredSessionsUnlocked();
    if (activeSessions.some(session => session.sourceKey === pending.sourceKey)) {
      throw new Error('This prompt already has an active Code Review lease');
    }

    const now = Date.now();
    const session: CodeReviewSession = {
      id: createId('review'),
      mode: 'code_review',
      owner: pending.owner,
      repo: pending.repo,
      approvedTabId: pending.sourceTabId,
      sourceKey: pending.sourceKey,
      sourcePath: pending.sourcePath,
      sourceRequestId: pending.requestId,
      jobId: pending.jobId,
      userTurnId: pending.userTurnId,
      capabilityId: createId('capability'),
      startedAt: now,
      expiresAt: now + pending.durationMinutes * 60_000,
      durationMinutes: pending.durationMinutes,
      callCount: 0,
      responseBytes: 0,
      allowedTools: [...CODE_REVIEW_ALLOWED_TOOLS],
    };
    await saveStoredSessions([...activeSessions, session]);
    await savePendingRequests(pendingRequests.filter(request => request.requestId !== pending.requestId));

    const base = {
      timestamp: now,
      requestId: pending.requestId,
      sessionId: session.id,
      jobId: session.jobId,
      userTurnId: session.userTurnId,
      capabilityId: session.capabilityId,
      owner: session.owner,
      repo: session.repo,
      tabId: session.approvedTabId,
      actorTabId: approvingTabId,
      originTabId: session.approvedTabId,
      sourcePath: session.sourcePath,
    };
    await appendAuditLog({ ...base, action: 'access_approved', reason: 'explicit user approval by requestId for the current user turn' });
    await appendAuditLog({ ...base, action: 'session_started', reason: `${session.durationMinutes} minute read-only prompt-bound lease` });
    await appendAuditLog({ ...base, action: 'job_started', reason: `${session.durationMinutes} minute read-only prompt-bound job` });
    return session;
  });
}

async function removeSessionUnlocked(sessionId: string): Promise<void> {
  const sessions = await loadStoredSessions();
  await saveStoredSessions(sessions.filter(session => session.id !== sessionId));
}

async function auditSessionEnd(session: CodeReviewSession, action: 'session_revoked' | 'session_expired', reason: string, actorTabId?: number) {
  const jobAction = action === 'session_revoked' ? 'job_revoked' : 'job_expired';
  const base = {
    timestamp: Date.now(),
    requestId: session.sourceRequestId,
    sessionId: session.id,
    jobId: session.jobId,
    userTurnId: session.userTurnId,
    capabilityId: session.capabilityId,
    owner: session.owner,
    repo: session.repo,
    tabId: session.approvedTabId,
    actorTabId,
    originTabId: session.approvedTabId,
    sourcePath: session.sourcePath,
    reason,
  };
  await appendAuditLog({ ...base, action });
  await appendAuditLog({ ...base, action: jobAction });
}

export async function revokeCodeReviewSession(
  sessionId: string,
  reason = 'manual revoke',
  actorTabId?: number,
): Promise<CodeReviewSession | null> {
  return withGateLock(async () => {
    const cleanSessionId = sanitizeOptionalString(sessionId, 200);
    if (!cleanSessionId) throw new Error('sessionId is required to revoke Code Review access');
    const sessions = await cleanupExpiredSessionsUnlocked();
    const session = sessions.find(item => item.id === cleanSessionId);
    if (!session) return null;
    await saveStoredSessions(sessions.filter(item => item.id !== cleanSessionId));
    await auditSessionEnd(session, 'session_revoked', reason, actorTabId);
    return session;
  });
}

export async function expireCodeReviewSession(sessionId: string): Promise<CodeReviewSession | null> {
  return withGateLock(async () => {
    const cleanSessionId = sanitizeOptionalString(sessionId, 200);
    if (!cleanSessionId) return null;
    const sessions = await loadStoredSessions();
    const session = sessions.find(item => item.id === cleanSessionId);
    if (!session) return null;
    await saveStoredSessions(sessions.filter(item => item.id !== cleanSessionId));
    await auditSessionEnd(session, 'session_expired', 'temporary Code Review lease expired automatically');
    return session;
  });
}

async function auditToolDenied(input: {
  session?: CodeReviewSession | null;
  toolName: string;
  callerTabId?: number;
  reason: string;
  argKeys: string[];
  resource?: string;
}): Promise<void> {
  await appendAuditLog({
    timestamp: Date.now(),
    action: 'tool_denied',
    requestId: input.session?.sourceRequestId,
    sessionId: input.session?.id,
    jobId: input.session?.jobId,
    userTurnId: input.session?.userTurnId,
    capabilityId: input.session?.capabilityId,
    toolName: input.toolName,
    owner: input.session?.owner,
    repo: input.session?.repo,
    tabId: input.callerTabId,
    originTabId: input.session?.approvedTabId,
    sourcePath: input.session?.sourcePath,
    argKeys: input.argKeys,
    resource: input.resource,
    reason: input.reason,
  });
}

async function auditScopeViolation(input: {
  session: CodeReviewSession;
  toolName: string;
  callerTabId?: number;
  reason: string;
  argKeys: string[];
  resource?: string;
}): Promise<void> {
  await appendAuditLog({
    timestamp: Date.now(),
    action: 'scope_violation',
    requestId: input.session.sourceRequestId,
    sessionId: input.session.id,
    jobId: input.session.jobId,
    userTurnId: input.session.userTurnId,
    capabilityId: input.session.capabilityId,
    toolName: input.toolName,
    owner: input.session.owner,
    repo: input.session.repo,
    tabId: input.callerTabId,
    originTabId: input.session.approvedTabId,
    sourcePath: input.session.sourcePath,
    argKeys: input.argKeys,
    resource: input.resource,
    reason: input.reason,
  });
}

function sanitizeSearchCodeQuery(query: unknown, session: CodeReviewSession): string {
  if (typeof query !== 'string' || !query.trim()) throw new Error('search_code requires a non-empty query');
  if (/\b(?:repo|org|user|owner):/i.test(query)) {
    throw new Error('Repository/org/user scope qualifiers are managed exclusively by the Code Review gate');
  }
  if (/\bOR\b/i.test(query)) throw new Error('OR queries are disabled in gated Code Review search; use separate searches instead');
  return `${query.trim()} repo:${session.owner}/${session.repo}`;
}

function enforceRepoScope(toolName: string, args: Record<string, any>, session: CodeReviewSession): Record<string, any> {
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
  callerTabId?: number,
  callerSourceUrl?: string,
): Promise<AuthorizedCodeReviewToolCall> {
  return withGateLock(async () => {
    const argKeys = Object.keys(args || {}).sort();
    const resource = extractSafeResource(args || {});
    const session = await getActiveSessionForOriginUnlocked(callerTabId, callerSourceUrl);
    if (!session) {
      const reason = 'no active prompt-bound Code Review lease exists for this exact origin/current user turn';
      await auditToolDenied({ session: null, toolName, callerTabId, argKeys, resource, reason });
      throw new Error('Code review access is OFF for this prompt. Explicit approval is required.');
    }

    if (!ALLOWED_TOOL_SET.has(toolName)) {
      const reason = 'tool is not in the Code Review read-only allowlist';
      await auditToolDenied({ session, toolName, callerTabId, argKeys, resource, reason });
      throw new Error(`Tool '${toolName}' is blocked by Code Review policy`);
    }

    if (session.callCount >= CODE_REVIEW_MAX_TOOL_CALLS) {
      const reason = 'job tool-call limit reached; lease revoked';
      await removeSessionUnlocked(session.id);
      await auditToolDenied({ session, toolName, callerTabId, argKeys, resource, reason });
      await auditSessionEnd(session, 'session_revoked', reason);
      throw new Error('Code Review call limit reached. This lease has been revoked.');
    }

    let sanitizedArgs: Record<string, any>;
    try {
      sanitizedArgs = enforceRepoScope(toolName, args || {}, session);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await auditScopeViolation({ session, toolName, callerTabId, argKeys, resource, reason });
      await auditToolDenied({ session, toolName, callerTabId, argKeys, resource, reason });
      throw error;
    }

    const sessions = await loadStoredSessions();
    await saveStoredSessions(sessions.map(item => (item.id === session.id ? { ...item, callCount: item.callCount + 1 } : item)));
    await appendAuditLog({
      timestamp: Date.now(),
      action: 'tool_allowed',
      requestId: session.sourceRequestId,
      sessionId: session.id,
      jobId: session.jobId,
      userTurnId: session.userTurnId,
      capabilityId: session.capabilityId,
      toolName,
      owner: session.owner,
      repo: session.repo,
      tabId: callerTabId,
      originTabId: session.approvedTabId,
      sourcePath: session.sourcePath,
      argKeys,
      resource,
    });
    return {
      args: sanitizedArgs,
      sessionId: session.id,
      jobId: session.jobId,
      userTurnId: session.userTurnId,
      capabilityId: session.capabilityId,
    };
  });
}

export async function enforceCodeReviewResultPolicy(
  toolName: string,
  result: any,
  sessionId: string,
  callerTabId?: number,
  callerSourceUrl?: string,
): Promise<any> {
  const serialized = JSON.stringify(result ?? null);
  const responseBytes = new TextEncoder().encode(serialized).byteLength;
  return withGateLock(async () => {
    const sessions = await cleanupExpiredSessionsUnlocked();
    const session = sessions.find(item => item.id === sessionId) || null;
    const currentTurnMatches = session ? await sessionMatchesCurrentTurnUnlocked(session) : false;
    if (!session || !originMatches(session, callerTabId, callerSourceUrl) || !currentTurnMatches) {
      await appendAuditLog({
        timestamp: Date.now(),
        action: 'response_denied',
        sessionId,
        jobId: session?.jobId,
        userTurnId: session?.userTurnId,
        capabilityId: session?.capabilityId,
        toolName,
        tabId: callerTabId,
        responseBytes,
        reason: 'lease expired/revoked, origin changed, or a new real user prompt superseded this job before result delivery',
      });
      throw new Error('Code Review lease ended before the tool result could be returned');
    }

    if (responseBytes > CODE_REVIEW_MAX_RESPONSE_BYTES) {
      const reason = `single response exceeded ${CODE_REVIEW_MAX_RESPONSE_BYTES} bytes`;
      await appendAuditLog({
        timestamp: Date.now(), action: 'response_denied', requestId: session.sourceRequestId, sessionId: session.id,
        jobId: session.jobId, userTurnId: session.userTurnId, capabilityId: session.capabilityId, toolName,
        owner: session.owner, repo: session.repo, tabId: callerTabId, originTabId: session.approvedTabId,
        sourcePath: session.sourcePath, responseBytes, reason,
      });
      throw new Error('Tool result is too large for gated Code Review. Request a narrower file/range/query.');
    }

    const nextTotal = session.responseBytes + responseBytes;
    if (nextTotal > CODE_REVIEW_MAX_SESSION_BYTES) {
      const reason = 'job response-byte limit reached; lease revoked';
      await removeSessionUnlocked(session.id);
      await appendAuditLog({
        timestamp: Date.now(), action: 'response_denied', requestId: session.sourceRequestId, sessionId: session.id,
        jobId: session.jobId, userTurnId: session.userTurnId, capabilityId: session.capabilityId, toolName,
        owner: session.owner, repo: session.repo, tabId: callerTabId, originTabId: session.approvedTabId,
        sourcePath: session.sourcePath, responseBytes, reason,
      });
      await auditSessionEnd(session, 'session_revoked', reason);
      throw new Error('Code Review data limit reached. This lease has been revoked.');
    }

    const currentSessions = await loadStoredSessions();
    await saveStoredSessions(currentSessions.map(item => (item.id === session.id ? { ...item, responseBytes: nextTotal } : item)));
    await appendAuditLog({
      timestamp: Date.now(),
      action: 'response_allowed',
      requestId: session.sourceRequestId,
      sessionId: session.id,
      jobId: session.jobId,
      userTurnId: session.userTurnId,
      capabilityId: session.capabilityId,
      toolName,
      owner: session.owner,
      repo: session.repo,
      tabId: callerTabId,
      originTabId: session.approvedTabId,
      sourcePath: session.sourcePath,
      responseBytes,
    });
    return result;
  });
}

export async function filterCodeReviewTools<T extends { name: string }>(
  tools: T[],
  callerTabId?: number,
  callerSourceUrl?: string,
): Promise<T[]> {
  const session = await getActiveCodeReviewSessionForOrigin(callerTabId, callerSourceUrl);
  if (!session) return [];
  return tools.filter(tool => ALLOWED_TOOL_SET.has(tool.name));
}

export async function getCodeReviewRequestTool() {
  const preferences = await getCodeReviewPreferences();
  const scopeDescription = preferences
    ? `Configured only by the user: ${preferences.owner}/${preferences.repo}, ${preferences.durationMinutes} minutes.`
    : 'No repository is configured yet. The user must save Code Review settings before this request can succeed.';
  return {
    name: CODE_REVIEW_REQUEST_TOOL_NAME,
    description:
      `Request explicit approval for the user's preconfigured temporary read-only GitHub Code Review scope. ${scopeDescription} ` +
      'This tool never reads GitHub, has no repository or duration parameters, and creates a pending approval bound to the current real user prompt. A later real user prompt requires a new approval.',
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  };
}

export async function getCodeReviewAuditLog(): Promise<CodeReviewAuditEntry[]> {
  const stored = await chrome.storage.local.get(AUDIT_STORAGE_KEY);
  return Array.isArray(stored[AUDIT_STORAGE_KEY]) ? stored[AUDIT_STORAGE_KEY] : [];
}
