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
const SIGNAL_DEDUPE_MS = 1_200;
const INTERNAL_SUBMISSION_GRACE_MS = 2_000;

let installed = false;
let internalSubmissionDepth = 0;
let internalSubmissionUntil = 0;
let lastSignalAt = 0;
let lastFingerprint = '';
let lastSubmissionId = '';

function createSubmissionId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `submission-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function currentPromptElement(): HTMLElement | null {
  return document.querySelector<HTMLElement>(PROMPT_SELECTOR);
}

function normalizePromptFingerprint(): string {
  const prompt = currentPromptElement();
  const text = (prompt?.textContent || (prompt as HTMLTextAreaElement | null)?.value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 256);
  // This fingerprint stays in memory and is never sent to the background. It
  // only merges click/keydown signals produced by one human submission.
  return `${window.location.pathname}|${text}`;
}

function isInternalSubmission(): boolean {
  return internalSubmissionDepth > 0 || Date.now() < internalSubmissionUntil;
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

async function sendUserTurn(clientSubmissionId: string): Promise<void> {
  try {
    await chrome.runtime.sendMessage({
      type: USER_TURN_MESSAGE,
      payload: { clientSubmissionId },
      origin: 'content',
      timestamp: Date.now(),
    });
  } catch {
    // Fail closed: the Gate will not create a pending request without a trusted
    // current UserTurn. Never invent a local turn or reuse an old lease.
  }
}

function registerTrustedUserSignal(): void {
  if (isInternalSubmission()) return;
  const submissionId = getSubmissionIdForSignal();
  const initialPath = window.location.pathname;
  void sendUserTurn(submissionId);

  // A brand-new ChatGPT chat receives /c/<id> shortly after the first prompt.
  // Mirror this same trusted submission into that generated pathname. Never
  // migrate a turn from one existing /c/* conversation into another.
  if (!initialPath.startsWith('/c/')) {
    for (const delay of [300, 900, 1_800]) {
      window.setTimeout(() => {
        if (window.location.pathname.startsWith('/c/') && window.location.pathname !== initialPath) {
          void sendUserTurn(submissionId);
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
  // `isTrusted` is the security boundary between a browser/user gesture and a
  // page/extension synthetic event. Model/page JS cannot manufacture true here.
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

export function installCodeReviewUserTurnDetector(): () => void {
  if (installed) return () => {};
  installed = true;
  // Capture before host React handlers clear/mutate the composer. We deliberately
  // do not trust generic submit events: human click/keydown is the authoritative
  // signal, while programmatic requestSubmit()/submit() must not create turns.
  document.addEventListener('click', onTrustedClick, true);
  document.addEventListener('keydown', onTrustedKeyDown, true);

  return () => {
    document.removeEventListener('click', onTrustedClick, true);
    document.removeEventListener('keydown', onTrustedKeyDown, true);
    installed = false;
  };
}

export async function runAsCodeReviewInternalSubmission<T>(operation: () => Promise<T>): Promise<T> {
  internalSubmissionDepth += 1;
  internalSubmissionUntil = Math.max(internalSubmissionUntil, Date.now() + INTERNAL_SUBMISSION_GRACE_MS);
  try {
    return await operation();
  } finally {
    internalSubmissionDepth = Math.max(0, internalSubmissionDepth - 1);
    internalSubmissionUntil = Math.max(internalSubmissionUntil, Date.now() + INTERNAL_SUBMISSION_GRACE_MS);
  }
}

export function isCodeReviewInternalSubmissionActive(): boolean {
  return isInternalSubmission();
}

// This module is loaded by the always-mounted MCP security UI. Self-installing
// keeps turn detection independent of whether the popover is open or closed.
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  if (document.body) installCodeReviewUserTurnDetector();
  else document.addEventListener('DOMContentLoaded', () => installCodeReviewUserTurnDetector(), { once: true });
}
