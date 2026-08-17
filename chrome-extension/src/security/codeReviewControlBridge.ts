import {
  CODE_REVIEW_ALLOWED_DURATIONS,
  clearCodeReviewAuditLog,
  createPendingCodeReviewRequest,
  getActiveCodeReviewSession,
  getCodeReviewAuditLog,
  getPendingCodeReviewRequest,
  recordCodeReviewAuditEvent,
  rejectPendingCodeReviewRequest,
  revokeCodeReviewSession,
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

export const CODE_REVIEW_CONTROL_MESSAGES = {
  STATUS: 'code-review:get-status',
  REQUEST: 'code-review:request',
  APPROVE: 'code-review:approve',
  REJECT: 'code-review:reject',
  REVOKE: 'code-review:revoke',
  AUDIT: 'code-review:get-audit',
  CLEAR_AUDIT: 'code-review:clear-audit',
} as const;

let bridgeRegistered = false;

function readRequestPayload(message: any): { owner: string; repo: string; durationMinutes: number } {
  const owner = typeof message.payload?.owner === 'string' ? message.payload.owner.trim() : '';
  const repo = typeof message.payload?.repo === 'string' ? message.payload.repo.trim() : '';
  const durationMinutes = Number(message.payload?.durationMinutes);

  if (!owner || !repo) {
    throw new Error('نام مالک و مخزن الزامی است.');
  }

  if (!CODE_REVIEW_ALLOWED_DURATIONS.includes(durationMinutes as 5 | 10 | 20)) {
    throw new Error('مدت دسترسی باید ۵، ۱۰ یا ۲۰ دقیقه باشد.');
  }

  return { owner, repo, durationMinutes };
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
  if (bridgeRegistered || typeof chrome === 'undefined' || !chrome.runtime?.onMessage) {
    return;
  }

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
    if (!message || typeof message.type !== 'string' || !message.type.startsWith('code-review:')) {
      return false;
    }

    const run = async () => {
      switch (message.type) {
        case CODE_REVIEW_CONTROL_MESSAGES.STATUS: {
          const [session, pendingRequest] = await Promise.all([
            getActiveCodeReviewSession(),
            getPendingCodeReviewRequest(),
          ]);
          return { success: true, session, pendingRequest };
        }

        // Kept for backwards compatibility. New requests normally arrive through
        // the local MCP tool request_code_review_access, not from the UI.
        case CODE_REVIEW_CONTROL_MESSAGES.REQUEST: {
          const { owner, repo, durationMinutes } = readRequestPayload(message);
          const tabId = sender.tab?.id;

          if (tabId === undefined) {
            throw new Error('درخواست دسترسی فقط از داخل تب مرورگر مجاز است.');
          }

          const request = await createPendingCodeReviewRequest({ owner, repo, durationMinutes });
          const sent = await notifyCodeReviewAccessRequested(owner, repo, durationMinutes);
          await auditNotificationResult({
            sent,
            owner,
            repo,
            tabId,
            reason: 'access_requested',
          });

          return { success: true, pendingRequest: request };
        }

        case CODE_REVIEW_CONTROL_MESSAGES.APPROVE: {
          const approvedTabId = sender.tab?.id;
          if (approvedTabId === undefined) {
            throw new Error('تأیید دسترسی فقط از داخل تب مرورگر مجاز است.');
          }

          const pending = await getPendingCodeReviewRequest();
          if (!pending) {
            throw new Error('هیچ درخواست دسترسی منتظر تأییدی وجود ندارد.');
          }

          // Approval is intentionally bound to the exact request previously
          // created by the AI-facing local MCP tool. The UI cannot substitute a
          // different repository or duration at approval time.
          const session = await startCodeReviewSession({
            owner: pending.owner,
            repo: pending.repo,
            durationMinutes: pending.durationMinutes,
            approvedTabId,
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
            tabId: approvedTabId,
            reason: 'session_started',
          });

          return { success: true, session, pendingRequest: null };
        }

        case CODE_REVIEW_CONTROL_MESSAGES.REJECT: {
          if (sender.tab?.id === undefined) {
            throw new Error('رد درخواست فقط از داخل تب مرورگر مجاز است.');
          }
          const rejected = await rejectPendingCodeReviewRequest('explicitly rejected by user');
          return { success: true, pendingRequest: null, rejected };
        }

        case CODE_REVIEW_CONTROL_MESSAGES.REVOKE: {
          const active = await getActiveCodeReviewSession();
          if (active && sender.tab?.id !== undefined && active.approvedTabId !== sender.tab.id) {
            throw new Error('لغو این نشست فقط از همان تبی که آن را تأیید کرده مجاز است.');
          }

          const revoked = await revokeCodeReviewSession('manual revoke from Persian Code Review UI');
          await clearCodeReviewExpiryNotification();

          const sent = await notifyCodeReviewRevoked(revoked?.owner, revoked?.repo);
          await auditNotificationResult({
            sent,
            sessionId: revoked?.id,
            owner: revoked?.owner,
            repo: revoked?.repo,
            tabId: sender.tab?.id,
            reason: 'session_revoked',
          });

          return { success: true, session: null };
        }

        case CODE_REVIEW_CONTROL_MESSAGES.AUDIT: {
          const entries = await getCodeReviewAuditLog();
          return { success: true, entries: entries.slice(-100) };
        }

        case CODE_REVIEW_CONTROL_MESSAGES.CLEAR_AUDIT: {
          await clearCodeReviewAuditLog();
          return { success: true, entries: [] };
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
