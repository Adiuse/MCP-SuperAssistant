import { createLogger } from '@extension/shared/lib/logger';

const logger = createLogger('CodeReviewNotifications');

const EXPIRY_ALARM_PREFIX = 'mcp-code-review-expiry:';
const EXPIRY_NOTICES_KEY = 'mcpCodeReviewExpiryNotices';
const DENIED_NOTIFICATION_COOLDOWN_MS = 10_000;

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
type ExpiryNoticeMap = Record<string, ExpiryNotice>;

let registered = false;
let lastDeniedNotificationAt = 0;
let lastDeniedFingerprint = '';

/** Desktop/system notifications are intentionally disabled. */
async function suppressDesktopNotification(title: string, message: string): Promise<boolean> {
  logger.debug(`[CodeReviewNotifications] Desktop notification suppressed: ${title} — ${message}`);
  return true;
}

async function loadExpiryNotices(): Promise<ExpiryNoticeMap> {
  const stored = await chrome.storage.local.get(EXPIRY_NOTICES_KEY);
  const raw = stored[EXPIRY_NOTICES_KEY];
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as ExpiryNoticeMap) : {};
}

async function saveExpiryNotices(notices: ExpiryNoticeMap): Promise<void> {
  if (Object.keys(notices).length === 0) {
    await chrome.storage.local.remove(EXPIRY_NOTICES_KEY);
    return;
  }
  await chrome.storage.local.set({ [EXPIRY_NOTICES_KEY]: notices });
}

function alarmName(sessionId: string): string {
  return `${EXPIRY_ALARM_PREFIX}${sessionId}`;
}

export async function notifyCodeReviewAccessRequested(
  owner: string,
  repo: string,
  durationMinutes: number,
): Promise<boolean> {
  return suppressDesktopNotification(
    'درخواست دسترسی Code Review',
    `درخواست دسترسی فقط‌خواندنی به ${owner}/${repo} برای ${durationMinutes} دقیقه ثبت شد.`,
  );
}

export async function notifyCodeReviewStarted(
  owner: string,
  repo: string,
  durationMinutes: number,
): Promise<boolean> {
  return suppressDesktopNotification(
    'دسترسی Code Review فعال شد',
    `${owner}/${repo} برای ${durationMinutes} دقیقه، فقط خواندنی فعال شد.`,
  );
}

export async function notifyCodeReviewRevoked(owner?: string, repo?: string): Promise<boolean> {
  const target = owner && repo ? ` برای ${owner}/${repo}` : '';
  return suppressDesktopNotification('دسترسی Code Review لغو شد', `دسترسی موقت${target} فوراً غیرفعال شد.`);
}

export async function notifyCodeReviewDenied(toolName: string, reason: string): Promise<boolean> {
  const now = Date.now();
  const fingerprint = `${toolName}:${reason}`;

  if (fingerprint === lastDeniedFingerprint && now - lastDeniedNotificationAt < DENIED_NOTIFICATION_COOLDOWN_MS) {
    return true;
  }

  lastDeniedFingerprint = fingerprint;
  lastDeniedNotificationAt = now;
  const shortReason = reason.length > 180 ? `${reason.slice(0, 177)}...` : reason;
  return suppressDesktopNotification('درخواست Code Review مسدود شد', `${toolName}: ${shortReason}`);
}

/**
 * Schedule one independent expiry alarm per session. A new approval must never
 * overwrite another origin's expiry timer.
 */
export async function scheduleCodeReviewExpiryNotification(input: ExpiryNotice): Promise<void> {
  if (typeof chrome === 'undefined' || !chrome.alarms?.create) return;

  try {
    const notices = await loadExpiryNotices();
    notices[input.sessionId] = input;
    await saveExpiryNotices(notices);
    await chrome.alarms.clear(alarmName(input.sessionId));
    chrome.alarms.create(alarmName(input.sessionId), { when: input.expiresAt });
  } catch (error) {
    logger.warn('[CodeReviewNotifications] Failed to schedule expiry alarm:', error);
  }
}

/** Clear one session alarm, or all Code Review expiry alarms when no id is supplied. */
export async function clearCodeReviewExpiryNotification(sessionId?: string): Promise<void> {
  if (typeof chrome === 'undefined') return;

  try {
    if (sessionId) {
      if (chrome.alarms?.clear) await chrome.alarms.clear(alarmName(sessionId));
      const notices = await loadExpiryNotices();
      if (notices[sessionId]) {
        delete notices[sessionId];
        await saveExpiryNotices(notices);
      }
      return;
    }

    if (chrome.alarms?.getAll && chrome.alarms?.clear) {
      const alarms = await chrome.alarms.getAll();
      await Promise.all(
        alarms
          .filter(alarm => alarm.name.startsWith(EXPIRY_ALARM_PREFIX))
          .map(alarm => chrome.alarms.clear(alarm.name)),
      );
    }
    await chrome.storage.local.remove(EXPIRY_NOTICES_KEY);
  } catch (error) {
    logger.warn('[CodeReviewNotifications] Failed to clear expiry alarm:', error);
  }
}

export function registerCodeReviewNotificationListeners(onExpired?: NotificationSentHandler): void {
  if (registered || typeof chrome === 'undefined' || !chrome.alarms?.onAlarm) return;
  registered = true;

  chrome.alarms.onAlarm.addListener(alarm => {
    if (!alarm.name.startsWith(EXPIRY_ALARM_PREFIX)) return;

    void (async () => {
      try {
        const sessionId = alarm.name.slice(EXPIRY_ALARM_PREFIX.length);
        if (!sessionId) return;

        const notices = await loadExpiryNotices();
        const notice = notices[sessionId];
        if (notice) {
          delete notices[sessionId];
          await saveExpiryNotices(notices);
        }

        if (notice && onExpired) {
          await onExpired({
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

  logger.debug('[CodeReviewNotifications] Per-session alarm listener registered; desktop notifications disabled');
}
