const USER_TURN_MESSAGE = 'code-review:user-turn';
const PROMPT_SELECTOR =
  '#prompt-textarea, .ProseMirror[contenteditable="true"], div[contenteditable="true"][data-id*="prompt"], textarea[data-id*="prompt"]';
const SEND_BUTTON_SELECTOR = [
  'button[data-testid="send-button"]',
  'button[data-testid="composer-submit-button"]',
  'button[aria-label="Send prompt"]',
  'button[aria-label="Send message"]',
  'button[aria-label="ارسال"]',
].join(',');
const USER_MESSAGE_SELECTOR = '[data-message-author-role="user"]';
const LAST_USER_MESSAGE_KEYS_STORAGE = 'mcpCodeReviewLastUserMessageKeys';
const SIGNAL_DEDUPE_MS = 1_200;
const TRUSTED_TO_DOM_LINK_MS = 8_000;
const INTERNAL_SUBMISSION_GRACE_MS = 2_000;
const INTERNAL_FINGERPRINT_TTL_MS = 30_000;
const MAX_TRACKED_CONVERSATIONS = 100;

let installed = false;
let internalSubmissionDepth = 0;
let internalSubmissionUntil = 0;
let lastSignalAt = 0;
let lastFingerprint = '';
let lastSubmissionId = '';
let recentTrustedSubmission: { id: string; expiresAt: number } | null = null;
let userMessageObserver: MutationObserver | null = null;
let scanScheduled = false;
const pendingInternalFingerprints = new Map<string, number>();

function createSubmissionId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `submission-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function currentPromptElement(): HTMLElement | null {
  return document.querySelector<HTMLElement>(PROMPT_SELECTOR);
}

function composerText(): string {
  const prompt = currentPromptElement();
  return (prompt?.textContent || (prompt as HTMLTextAreaElement | null)?.value || '').trim();
}

function normalizedText(value: string): string {
  return value.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

function normalizePromptFingerprint(): string {
  // Local-only dedupe state. Prompt content is never sent to the Gate.
  return `${window.location.pathname}|${normalizedText(composerText()).slice(0, 256)}`;
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function isInternalSubmission(): boolean {
  return internalSubmissionDepth > 0 || Date.now() < internalSubmissionUntil;
}

function pruneInternalFingerprints(): void {
  const now = Date.now();
  for (const [fingerprint, expiresAt] of pendingInternalFingerprints) {
    if (expiresAt <= now) pendingInternalFingerprints.delete(fingerprint);
  }
}

function getSubmissionIdForSignal(): string {
  const now = Date.now();
  const fingerprint = normalizePromptFingerprint();
  if (lastSubmissionId && now - lastSignalAt <= SIGNAL_DEDUPE_MS && fingerprint === lastFingerprint) {
    lastSignalAt = now;
    return lastSubmissionId;
  }
  lastSignalAt = now;
  lastFingerprint = fingerprint;
  lastSubmissionId = createSubmissionId();
  return lastSubmissionId;
}

async function sendUserTurn(clientSubmissionId: string): Promise<boolean> {
  try {
    const response = await chrome.runtime.sendMessage({
      type: USER_TURN_MESSAGE,
      payload: { clientSubmissionId },
      origin: 'content',
      timestamp: Date.now(),
    });
    return response?.success === true;
  } catch {
    // Fail closed: the Gate will not create a pending request without a trusted
    // current UserTurn. Never invent a local turn or reuse an old lease.
    return false;
  }
}

function registerTrustedUserSignal(): void {
  if (isInternalSubmission()) return;
  const submissionId = getSubmissionIdForSignal();
  const initialPath = window.location.pathname;
  recentTrustedSubmission = { id: submissionId, expiresAt: Date.now() + TRUSTED_TO_DOM_LINK_MS };
  void sendUserTurn(submissionId);

  // A brand-new ChatGPT chat receives /c/<id> shortly after the first prompt.
  // Mirror this same trusted submission into that generated pathname. Never
  // migrate a turn from one existing /c/* conversation into another.
  if (!initialPath.startsWith('/c/')) {
    for (const delay of [300, 900, 1_800]) {
      window.setTimeout(() => {
        if (window.location.pathname.startsWith('/c/') && window.location.pathname !== initialPath) {
          void sendUserTurn(submissionId);
          scheduleUserMessageScan();
        }
      }, delay);
    }
  }
}

function isUsableSendButton(element: Element | null): boolean {
  const button = element?.closest<HTMLButtonElement>(SEND_BUTTON_SELECTOR);
  if (!button) return false;
  return !button.disabled && button.getAttribute('aria-disabled') !== 'true';
}

function onTrustedClick(event: MouseEvent): void {
  // Local user gestures are a fast-path. Remote/device prompts are caught by
  // the user-message DOM observer below.
  if (!event.isTrusted || isInternalSubmission()) return;
  if (!isUsableSendButton(event.target as Element | null)) return;
  registerTrustedUserSignal();
}

function onTrustedKeyDown(event: KeyboardEvent): void {
  if (!event.isTrusted || isInternalSubmission()) return;
  if (event.key !== 'Enter' || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey || event.isComposing) return;
  const target = event.target as Element | null;
  if (!target?.closest(PROMPT_SELECTOR)) return;
  registerTrustedUserSignal();
}

function latestUserMessage(): HTMLElement | null {
  const messages = document.querySelectorAll<HTMLElement>(USER_MESSAGE_SELECTOR);
  return messages.length > 0 ? messages[messages.length - 1] : null;
}

function userMessageText(message: HTMLElement): string {
  const content =
    message.querySelector<HTMLElement>('[data-message-content]') ||
    message.querySelector<HTMLElement>('.whitespace-pre-wrap') ||
    message;
  return normalizedText(content.textContent || '');
}

async function userMessageKey(message: HTMLElement, text: string): Promise<string> {
  const withId = message.closest<HTMLElement>('[data-message-id]') || message.querySelector<HTMLElement>('[data-message-id]');
  const messageId = withId?.getAttribute('data-message-id')?.trim();
  if (messageId) return `id:${messageId}`.slice(0, 180);
  return `sha256:${await sha256(text)}`;
}

async function readLastMessageKeys(): Promise<Record<string, string>> {
  try {
    const stored = await chrome.storage.local.get(LAST_USER_MESSAGE_KEYS_STORAGE);
    const value = stored[LAST_USER_MESSAGE_KEYS_STORAGE];
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

async function persistLastMessageKey(sourcePath: string, key: string): Promise<void> {
  try {
    const current = await readLastMessageKeys();
    const entries = Object.entries({ ...current, [sourcePath]: key });
    await chrome.storage.local.set({
      [LAST_USER_MESSAGE_KEYS_STORAGE]: Object.fromEntries(entries.slice(-MAX_TRACKED_CONVERSATIONS)),
    });
  } catch {
    // A persistence failure can only cause a conservative re-registration later.
  }
}

async function scanLatestUserMessage(): Promise<void> {
  const sourcePath = window.location.pathname;
  const message = latestUserMessage();
  if (!message || !sourcePath) return;
  const text = userMessageText(message);
  const key = await userMessageKey(message, text);
  const stored = await readLastMessageKeys();
  if (stored[sourcePath] === key) return;

  pruneInternalFingerprints();
  const contentFingerprint = await sha256(text);
  if (pendingInternalFingerprints.has(contentFingerprint)) {
    pendingInternalFingerprints.delete(contentFingerprint);
    await persistLastMessageKey(sourcePath, key);
    return;
  }

  const linkedTrusted = recentTrustedSubmission && recentTrustedSubmission.expiresAt > Date.now()
    ? recentTrustedSubmission.id
    : null;
  const submissionId = linkedTrusted || `dom:${key}`.slice(0, 200);
  const registered = await sendUserTurn(submissionId);
  if (registered) {
    await persistLastMessageKey(sourcePath, key);
    if (linkedTrusted) recentTrustedSubmission = null;
  }
}

function scheduleUserMessageScan(): void {
  if (scanScheduled) return;
  scanScheduled = true;
  queueMicrotask(() => {
    scanScheduled = false;
    void scanLatestUserMessage();
  });
}

function startUserMessageObserver(): void {
  scheduleUserMessageScan();
  userMessageObserver?.disconnect();
  userMessageObserver = new MutationObserver(scheduleUserMessageScan);
  userMessageObserver.observe(document.body, { childList: true, subtree: true });
}

export function installCodeReviewUserTurnDetector(): () => void {
  if (installed) return () => {};
  installed = true;
  document.addEventListener('click', onTrustedClick, true);
  document.addEventListener('keydown', onTrustedKeyDown, true);
  startUserMessageObserver();

  return () => {
    document.removeEventListener('click', onTrustedClick, true);
    document.removeEventListener('keydown', onTrustedKeyDown, true);
    userMessageObserver?.disconnect();
    userMessageObserver = null;
    installed = false;
  };
}

export async function runAsCodeReviewInternalSubmission<T>(operation: () => Promise<T>): Promise<T> {
  internalSubmissionDepth += 1;
  internalSubmissionUntil = Math.max(internalSubmissionUntil, Date.now() + INTERNAL_SUBMISSION_GRACE_MS);
  const text = normalizedText(composerText());
  if (text) {
    try {
      const fingerprint = await sha256(text);
      pendingInternalFingerprints.set(fingerprint, Date.now() + INTERNAL_FINGERPRINT_TTL_MS);
    } catch {
      // Even if fingerprinting is unavailable, synthetic clicks remain untrusted.
    }
  }
  try {
    return await operation();
  } finally {
    internalSubmissionDepth = Math.max(0, internalSubmissionDepth - 1);
    internalSubmissionUntil = Math.max(internalSubmissionUntil, Date.now() + INTERNAL_SUBMISSION_GRACE_MS);
    window.setTimeout(scheduleUserMessageScan, 150);
  }
}

export function isCodeReviewInternalSubmissionActive(): boolean {
  return isInternalSubmission();
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  if (document.body) installCodeReviewUserTurnDetector();
  else document.addEventListener('DOMContentLoaded', () => installCodeReviewUserTurnDetector(), { once: true });
}
