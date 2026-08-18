import { createLogger } from '@extension/shared/lib/logger';

const logger = createLogger('CodeReviewNotifications');

const EXPIRY_ALARM_NAME = 'mcp-code-review-expiry';
const EXPIRY_NOTICE_KEY = 'mcpCodeReviewExpiryNotice';
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
  repo: string