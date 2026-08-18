import { createLogger } from '@extension/shared/lib/logger';

const logger = createLogger('CodeReviewNotifications');

const EXPIRY_ALARM_NAME = 'mcp-code-review-expiry';
const EXPIRY_NOTICE_KEY = 'mcpCodeReviewExpiryNotice';
const DENIED_NOTIFICATION_COOLDOWN_MS = 10_000;
const NOTIFICATION_AUTO_DISMISS_MS = 5_000;

export interface ExpiryNotice {
  sessionId: string;
  owner: string;
  repo: string;
  expiresAt: number;
}

export interface CodeReviewNotificationEvent {
  kind: 'session_expired';
  sessionId: string;
  owner: string;
  repo: string;
}

type NotificationSentHandler = (event: CodeReviewNotificationEvent) => void | Promise<void>;

let registered = false;
let lastDeniedNotificationAt = 0;
let lastDeniedFingerprint = '';

function canNotify(): boolean {
  return typeof chrome !== 'undefined' && Boolean(chrome.notifications?.create);
}

function scheduleNotificationDismiss(notificationId: string): void {
  globalThis.setTimeout(() => {
    void chrome.notifications.clear(notificationId).catch(error => {
      logger.debug('[CodeReviewNotifications] Auto-dismiss skipped:', error);
    });
  }, NOTIFICATION_AUTO_DISMISS_MS);
}

async function createSecurityNotification(title: string, message: string): Promise<boolean> {
  if (!canNotify()) return false;

  try {
    const notificationId = await chrome.notifications.create({
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icon-128.png'),
      title,
      message,
      priority: 2,
      requireInteraction: false,
    });

    if (notificationId) {
      scheduleNotificationDismiss(notificationId);
    }

    return true;
  } catch (error) {
    logger.warn('[CodeReviewNotifications] Failed to create notification:', error);
    return false;
  }
}

export async function notifyCodeReviewAccessRequested(
  owner: string,
  repo: string,
  durationMinutes: number,
): Promise<boolean> {
  return await createSecurityNotification(
    'درخواست دسترسی Code Review',
    `درخواست دسترسی فقط‌خواندنی به ${owner}/${repo} برای ${durationMinutes} دقیقه ثبت شد. برای فعال‌سازی، تأیید نهایی لازم است.`,
  );
}

export async function notifyCodeReviewStarted(
  owner: string,
  repo: string,
  durationMinutes: number,
): Promise<boolean> {
  return await createSecurityNotification(
    'دسترسی Code Review فعال شد',
    `${owner}/${repo} برای ${durationMinutes} دقیقه، فقط خواندنی فعال شد.`,
  );
}

export async function notifyCodeReviewRevoked(owner?: string, repo?: string): Promise<boolean> {
  const target = owner && repo ? ` برای ${owner}/${repo}` : '';
  return await createSecurityNotification('دسترسی Code Review لغو شد', `دسترسی موقت${target} فوراً غیرفعال شد.`);
}

export async function notifyCodeReviewDenied(toolName: string, reason: string): Promise<boolean> {
  const now = Date.now();
  const fingerprint = `${toolName}:${reason}`;

  if (fingerprint === lastDeniedFingerprint && now - lastDeniedNotificationAt < DENIED_NOTIFICATION_COOLDOWN_MS) {
    return false;
  }

  lastDeniedFingerprint = fingerprint;
  lastDeniedNotificationAt = now;

  const shortReason = reason.length > 180 ? `${reason.slice(0, 177)}...` : reason;
  return await createSecurityNotification(
    'درخواست Code Review مسدود شد',
    `${toolName}: ${shortReason}`,
  );
}

export async function scheduleCodeReviewExpiryNotification(input: ExpiryNotice): Promise<void> {
  if (typeof chrome === 'undefined' || !chrome.alarms?.create) return;

  try {
    await chrome.storage.local.set({ [EXPIRY_NOTICE_KEY]: input });
    await chrome.alarms.clear(EXPIRY_ALARM_NAME);
    chrome.alarms.create(EXPIRY_ALARM_NAME, { when: input.expiresAt });
  } catch (error) {
    logger.warn('[CodeReviewNotifications] Failed to schedule expiry notification:', error);
  }
}

export async function clearCodeReviewExpiryNotification(): Promise<void> {
  if (typeof chrome === 'undefined') return;

  try {
    if (chrome.alarms?.clear) {
      await chrome.alarms.clear(EXPIRY_ALARM_NAME);
    }
    await chrome.storage.local.remove(EXPIRY_NOTICE_KEY);
  } catch (error) {
    logger.warn('[CodeReviewNotifications] Failed to clear expiry notification:', error);
  }
}

export function registerCodeReviewNotificationListeners(onSent?: NotificationSentHandler): void {
  if (registered || typeof chrome === 'undefined' || !chrome.alarms?.onAlarm) return;
  registered = true;

  chrome.alarms.onAlarm.addListener(alarm => {
    if (alarm.name !== EXPIRY_ALARM_NAME) return;

    void (async () => {
      try {
        const stored = await chrome.storage.local.get(EXPIRY_NOTICE_KEY);
        const notice = stored[EXPIRY_NOTICE_KEY] as ExpiryNotice | undefined;
        await chrome.storage.local.remove(EXPIRY_NOTICE_KEY);

        if (!notice) return;

        const sent = await createSecurityNotification(
          'دسترسی Code Review منقضی شد',
          `دسترسی ${notice.owner}/${notice.repo} پایان یافت. برای بررسی جدید دوباره تأیید کنید.`,
        );

        if (sent && onSent) {
          await onSent({
            kind: 'session_expired',
            sessionId: notice.sessionId,
            owner: notice.owner,
            repo: notice.repo,
          });
        }
      } catch (error) {
        logger.warn('[CodeReviewNotifications] Expiry alarm handling failed:', error);
      }
    })();
  });

  logger.debug('[CodeReviewNotifications] Alarm listener registered');
}
