import {
  getActiveCodeReviewSession,
  getCodeReviewAuditLog,
  revokeCodeReviewSession,
  startCodeReviewSession,
} from './codeReviewGate.js';
import { createLogger } from '@extension/shared/lib/logger';

const logger = createLogger('CodeReviewControlBridge');

export const CODE_REVIEW_CONTROL_MESSAGES = {
  STATUS: 'code-review:get-status',
  APPROVE: 'code-review:approve',
  REVOKE: 'code-review:revoke',
  AUDIT: 'code-review:get-audit',
} as const;

let bridgeRegistered = false;

/**
 * Registers the owner-controlled Code Review session API in the extension
 * background context. The approval tab id is taken from MessageSender, never
 * from untrusted message payload.
 */
export function registerCodeReviewControlBridge(): void {
  if (bridgeRegistered || typeof chrome === 'undefined' || !chrome.runtime?.onMessage) {
    return;
  }

  bridgeRegistered = true;

  chrome.runtime.onMessage.addListener((message: any, sender, sendResponse) => {
    if (!message || typeof message.type !== 'string' || !message.type.startsWith('code-review:')) {
      return false;
    }

    const run = async () => {
      switch (message.type) {
        case CODE_REVIEW_CONTROL_MESSAGES.STATUS: {
          const session = await getActiveCodeReviewSession();
          return { success: true, session };
        }

        case CODE_REVIEW_CONTROL_MESSAGES.APPROVE: {
          const owner = typeof message.payload?.owner === 'string' ? message.payload.owner.trim() : '';
          const repo = typeof message.payload?.repo === 'string' ? message.payload.repo.trim() : '';
          const durationMinutes = Number(message.payload?.durationMinutes);
          const approvedTabId = sender.tab?.id;

          if (!owner || !repo) {
            throw new Error('نام مالک و مخزن الزامی است.');
          }

          if (approvedTabId === undefined) {
            throw new Error('تأیید دسترسی فقط از داخل تب مرورگر مجاز است.');
          }

          const session = await startCodeReviewSession({
            owner,
            repo,
            durationMinutes,
            approvedTabId,
          });

          return { success: true, session };
        }

        case CODE_REVIEW_CONTROL_MESSAGES.REVOKE: {
          const active = await getActiveCodeReviewSession();
          if (active && sender.tab?.id !== undefined && active.approvedTabId !== sender.tab.id) {
            throw new Error('لغو این نشست فقط از همان تبی که آن را تأیید کرده مجاز است.');
          }

          await revokeCodeReviewSession('manual revoke from Persian Code Review UI');
          return { success: true, session: null };
        }

        case CODE_REVIEW_CONTROL_MESSAGES.AUDIT: {
          const entries = await getCodeReviewAuditLog();
          return { success: true, entries: entries.slice(-100) };
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
