import {
  CODE_REVIEW_ALLOWED_DURATIONS,
  clearCodeReviewAuditLog,
  createPendingCodeReviewRequest,
  getActiveCodeReviewSession,
  getCodeReviewAuditLog,
  getCodeReviewPreferences,
  getPendingCodeReviewRequests,
  recordCodeReviewAuditEvent,
  rejectPendingCodeReviewRequest,
  revokeCodeReviewSession,
  saveCodeReviewPreferences,
  startCodeReviewSession,
} from './codeReviewGate.js';
import {
  clearCodeReviewExpiryNotification,
  notifyCodeReviewAccessRequested,
  notifyCodeReviewRevoked,
  notifyCodeReviewStarted,
  registerCodeReviewNotificationListeners,
  scheduleCodeReviewExpiryNotification,
} from './codeReviewNotifications.js';
import { createLogger } from '@extension/shared/lib/logger';

const logger = createLogger('CodeReviewControlBridge');
const CALLER_CONTEXT_TTL_MS = 30_000;
const MAX_CALLER_CONTEXTS = 500;

export const CODE_REVIEW_CONTROL_MESSAGES = {
  STATUS: 'code-review:get-status',
  SETTINGS: 'code-review:get-settings',
  SAVE_SETTINGS: 'code-review:save-settings',
  REQUEST: 'code-review:request',
  APPROVE: 'code-review:approve',
  REJECT: 'code-review:reject',
  REVOKE: 'code-review:revoke',
  AUDIT: 'code-review:get-audit',
  CLEAR_AUDIT: 'code-review:clear-audit',
} as const;

export interface CodeReviewCallerContext {
  tabId: number;
  sourceUrl?: string;
  capturedAt: number;
}

let bridgeRegistered = false;
const callerContextQueues = new Map<string, CodeReviewCallerContext[]>();

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? String(value) : serialized;
  }
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;

  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map(key => `${JSON.stringify(key)}:${stableSerialize(record[key])}`)
    .join(',')}}`;
}

function callerContextKey(toolName: string, args: unknown): string {
  return `${toolName}|${stableSerialize(args || {})}`;
}

function pruneCallerContexts(): void {
  const cutoff = Date.now() - CALLER_CONTEXT_TTL_MS;
  let total = 0;

  for (const [key, queue] of callerContextQueues) {
    const fresh = queue.filter(item => item.capturedAt >= cutoff);
    if (fresh.length === 0) {
      callerContextQueues.delete(key);
      continue;
    }
    callerContextQueues.set(key, fresh);
    total += fresh.length;
  }

  if (total <= MAX_CALLER_CONTEXTS) return;

  const all = [...callerContextQueues.entries()]
    .flatMap(([key, queue]) => queue.map(item => ({ key, item })))
    .sort((a, b) => a.item.capturedAt - b.item.capturedAt);

  for (const entry of all.slice(0, total - MAX_CALLER_CONTEXTS)) {
    const queue = callerContextQueues.get(entry.key);
    if (!queue) continue;
    const index = queue.indexOf(entry.item);
    if (index >= 0) queue.splice(index, 1);
    if (queue.length === 0) callerContextQueues.delete(entry.key);
  }
}

function captureCodeReviewCallerContext(
  toolName: string,
  args: unknown,
  sender: chrome.runtime.MessageSender,
): void {
  const tabId = sender.tab?.id;
  if (tabId === undefined) return;

  pruneCallerContexts();
  const key = callerContextKey(toolName, args);
  const queue = callerContextQueues.get(key) || [];
  queue.push({ tabId, sourceUrl: sender.tab?.url, capturedAt: Date.now() });
  callerContextQueues.set(key, queue);
}

export function consumeCodeReviewCallerContext(
  toolName: string,
  args: unknown,
): CodeReviewCallerContext | null {
  pruneCallerContexts();
  const key = callerContextKey(toolName, args);
  const queue = callerContextQueues.get(key);
  if (!queue || queue.length === 0) return null;

  const context = queue.shift() || null;
  if (queue.length === 0) callerContextQueues.delete(key);
  return context;
}

function readSettingsPayload(message: any): { owner: string; repo: string; durationMinutes: number } {
  const owner = typeof message.payload?.owner === 'string' ? message.payload.owner.trim() : '';
  const repo = typeof message.payload?.repo === 'string' ? message.payload.repo.trim() : '';
  const durationMinutes = Number(message.payload?.durationMinutes);

  if (!owner || !repo) throw new Error('نام مالک و مخزن الزامی است.');
  if (!CODE_REVIEW_ALLOWED_DURATIONS.includes(durationMinutes as 5 | 10 | 20)) {
    throw new Error('مدت دسترسی باید ۵، ۱۰ یا ۲۰ دقیقه باشد.');
  }

  return { owner, repo, durationMinutes };
}

function readRequestId(message: any): string {
  const requestId = typeof message.payload?.requestId === 'string' ? message.payload.requestId.trim() : '';
  if (!requestId) throw new Error('شناسه درخواست دسترسی الزامی است.');
  return requestId;
}

function safeSourcePath(url?: string): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`.slice(0, 500);
  } catch {
    return undefined;
  }
}

async function auditNotificationResult(input: {
  sent: boolean;
  sessionId?: string;
  owner?: string;
  repo?: string;
  tabId?: number;
  reason: string;
}): Promise<void> {
  await recordCodeReviewAuditEvent({
    timestamp: Date.now(),
    action: input.sent ? 'notification_sent' : 'notification_failed',
    sessionId: input.sessionId,
    owner: input.owner,
    repo: input.repo,
    tabId: input.tabId,
    reason: input.reason,
  });
}

export function registerCodeReviewControlBridge(): void {
  if (bridgeRegistered || typeof chrome === 'undefined' || !chrome.runtime?.onMessage) return;
  bridgeRegistered = true;

  registerCodeReviewNotificationListeners(async event => {
    await recordCodeReviewAuditEvent({
      timestamp: Date.now(),
      action: 'notification_sent',
      sessionId: event.sessionId,
      owner: event.owner,
      repo: event.repo,
      reason: 'session_expired',
    });
  });

  chrome.runtime.onMessage.addListener((message: any, sender, sendResponse) => {
    if (message?.type === 'mcp:call-tool') {
      const toolName = message.payload?.toolName;
      if (typeof toolName === 'string' && toolName) {
        captureCodeReviewCallerContext(toolName, message.payload?.args || {}, sender);
      }
      return false;
    }

    if (!message || typeof message.type !== 'string' || !message.type.startsWith('code-review:')) return false;

    const run = async () => {
      switch (message.type) {
        case CODE_REVIEW_CONTROL_MESSAGES.STATUS: {
          const [session, pendingRequests, settings] = await Promise.all([
            getActiveCodeReviewSession(),
            getPendingCodeReviewRequests(),
            getCodeReviewPreferences(),
          ]);
          return {
            success: true,
            currentTabId: sender.tab?.id,
            session,
            settings,
            pendingRequests,
            pendingRequest: pendingRequests[0] || null,
          };
        }

        case CODE_REVIEW_CONTROL_MESSAGES.SETTINGS: {
          const settings = await getCodeReviewPreferences();
          return { success: true, currentTabId: sender.tab?.id, settings };
        }

        case CODE_REVIEW_CONTROL_MESSAGES.SAVE_SETTINGS: {
          const input = readSettingsPayload(message);
          const settings = await saveCodeReviewPreferences(input);
          return { success: true, currentTabId: sender.tab?.id, settings };
        }

        case CODE_REVIEW_CONTROL_MESSAGES.REQUEST: {
          const tabId = sender.tab?.id;
          if (tabId === undefined) throw new Error('درخواست دسترسی فقط از داخل تب مرورگر مجاز است.');

          const sourcePath = safeSourcePath(sender.tab?.url);
          const request = await createPendingCodeReviewRequest({
            sourceTabId: tabId,
            sourcePath,
            sourceKey: sourcePath ? `${tabId}:${sourcePath}` : `tab:${tabId}`,
          });

          const sent = await notifyCodeReviewAccessRequested(
            request.owner,
            request.repo,
            request.durationMinutes,
          );
          await auditNotificationResult({
            sent,
            owner: request.owner,
            repo: request.repo,
            tabId,
            reason: 'access_requested',
          });

          return { success: true, currentTabId: tabId, pendingRequest: request };
        }

        case CODE_REVIEW_CONTROL_MESSAGES.APPROVE: {
          const requestId = readRequestId(message);
          const approvingTabId = sender.tab?.id;
          if (approvingTabId === undefined) throw new Error('تأیید دسترسی فقط از داخل تب مرورگر مجاز است.');

          const pendingRequests = await getPendingCodeReviewRequests();
          const pending = pendingRequests.find(request => request.id === requestId);
          if (!pending) throw new Error('این درخواست دیگر در صف انتظار وجود ندارد.');

          const session = await startCodeReviewSession({
            owner: pending.owner,
            repo: pending.repo,
            durationMinutes: pending.durationMinutes,
            approvedTabId: approvingTabId,
            requestId: pending.id,
          });

          await scheduleCodeReviewExpiryNotification({
            sessionId: session.id,
            owner: session.owner,
            repo: session.repo,
            expiresAt: session.expiresAt,
          });

          const sent = await notifyCodeReviewStarted(session.owner, session.repo, session.durationMinutes);
          await auditNotificationResult({
            sent,
            sessionId: session.id,
            owner: session.owner,
            repo: session.repo,
            tabId: session.approvedTabId,
            reason: 'session_started',
          });

          const remaining = await getPendingCodeReviewRequests();
          return {
            success: true,
            currentTabId: approvingTabId,
            session,
            pendingRequests: remaining,
            pendingRequest: remaining[0] || null,
          };
        }

        case CODE_REVIEW_CONTROL_MESSAGES.REJECT: {
          if (sender.tab?.id === undefined) throw new Error('رد درخواست فقط از داخل تب مرورگر مجاز است.');
          const requestId = readRequestId(message);
          const rejected = await rejectPendingCodeReviewRequest('explicitly rejected by user', requestId);
          if (!rejected) throw new Error('این درخواست دیگر در صف انتظار وجود ندارد.');
          const remaining = await getPendingCodeReviewRequests();
          return {
            success: true,
            currentTabId: sender.tab.id,
            pendingRequests: remaining,
            pendingRequest: remaining[0] || null,
            rejected,
          };
        }

        case CODE_REVIEW_CONTROL_MESSAGES.REVOKE: {
          if (sender.tab?.id === undefined) throw new Error('لغو دسترسی فقط از داخل تب مرورگر مجاز است.');

          const revoked = await revokeCodeReviewSession('manual global revoke from Persian Code Review UI');
          await clearCodeReviewExpiryNotification();
          const sent = await notifyCodeReviewRevoked(revoked?.owner, revoked?.repo);
          await auditNotificationResult({
            sent,
            sessionId: revoked?.id,
            owner: revoked?.owner,
            repo: revoked?.repo,
            tabId: sender.tab.id,
            reason: 'session_revoked',
          });

          const pendingRequests = await getPendingCodeReviewRequests();
          return {
            success: true,
            currentTabId: sender.tab.id,
            session: null,
            pendingRequests,
            pendingRequest: pendingRequests[0] || null,
          };
        }

        case CODE_REVIEW_CONTROL_MESSAGES.AUDIT: {
          const entries = await getCodeReviewAuditLog();
          return { success: true, currentTabId: sender.tab?.id, entries: entries.slice(-100) };
        }

        case CODE_REVIEW_CONTROL_MESSAGES.CLEAR_AUDIT: {
          await clearCodeReviewAuditLog();
          return { success: true, currentTabId: sender.tab?.id, entries: [] };
        }

        default:
          return { success: false, error: 'پیام کنترل دسترسی ناشناخته است.' };
      }
    };

    run()
      .then(result => sendResponse(result))
      .catch(error => {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.warn('[CodeReviewControlBridge] Request failed:', errorMessage);
        sendResponse({ success: false, error: errorMessage });
      });

    return true;
  });

  logger.debug('[CodeReviewControlBridge] Registered');
}
