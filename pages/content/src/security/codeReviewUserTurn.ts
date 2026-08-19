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
  // This fingerprint never leaves the content script. It exists only to merge
  // the trusted keydown/click/submit events produced by one human submission.
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
    // The Gate fails closed if a real turn cannot be registered. Do not invent a
    // local userTurnId or silently authorize an old lease as a fallback.
  }
}

function registerTrustedUserSignal(): void {
  if (isInternalSubmission()) return;
  const submissionId = getSubmissionIdForSignal();
  const initialPath = window.location.pathname;
  void sendUserTurn(submissionId);

  // ChatGPT creates /c/<id> only after the first prompt in a new chat. Mirror
  // the same trusted submission into that newly-created conversation pathname,
  // but never migrate a turn from one existing /c/* conversation to another.
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

function onTrustedSubmit(event: SubmitEvent): void {
  if (!event.isTrusted || isInternalSubmission()) return;
  const form = event.target instanceof HTMLFormElement ? event.target : null;
  if (!form || !form.querySelector(PROMPT_SELECTOR)) return;
  registerTrustedUserSignal();
}

export function installCodeReviewUserTurnDetector(): () => void {
  if (installed) return () => {};
  installed = true;

  // Capture phase observes the browser-trusted human gesture before host React
  // handlers clear the composer. Synthetic extension/page events have
  // event.isTrusted === false and cannot manufacture a trusted UserTurn.
  document.addEventListener('click', onTrustedClick, true);
  document.addEventListener('keydown', onTrustedKeyDown, true);
  document.addEventListener('submit', onTrustedSubmit, true);

  return () => {
    document.removeEventListener('click', onTrustedClick, true);
    document.removeEventListener('keydown', onTrustedKeyDown, true);
    document.removeEventListener('submit', onTrustedSubmit, true);
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
