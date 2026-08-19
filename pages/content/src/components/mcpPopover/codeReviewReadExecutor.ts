const REVIEW_STATUS_MESSAGE = 'code-review:get-status';
const SECURITY_TOAST_EVENT = 'mcp-security-toast';

const READ_TOOL_NAMES = new Set([
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
]);

type ParsedReadCall = {
  toolName: string;
  callId: string;
  args: Record<string, unknown>;
};

type StatusResponse = {
  success?: boolean;
  currentTabId?: number;
  originSession?: {
    id?: string;
    approvedTabId?: number;
    expiresAt?: number;
  } | null;
};

type AutomationState = {
  autoExecute: boolean;
  autoInsert: boolean;
  autoSubmit: boolean;
  autoInsertDelay: number;
  autoSubmitDelay: number;
};

declare global {
  interface Window {
    __mcpCodeReviewReadExecutorInstalled?: boolean;
    __mcpAutomationState?: {
      autoExecute?: boolean;
      autoInsert?: boolean;
      autoSubmit?: boolean;
      autoInsertDelay?: number;
      autoSubmitDelay?: number;
    };
    toggleState?: {
      autoExecute?: boolean;
      autoInsert?: boolean;
      autoSubmit?: boolean;
    };
    pluginRegistry?: any;
    mcpAdapter?: any;
    getCurrentAdapter?: () => any;
  }
}

const completedCalls = new Set<string>();
const inFlightCalls = new Set<string>();
const attemptsBySource = new WeakMap<HTMLElement, number>();
let observer: MutationObserver | null = null;
let scanScheduled = false;
let disposed = false;

function emitRuntimeToast(title: string, message: string, variant: 'info' | 'success' | 'warning' | 'error'): void {
  window.dispatchEvent(
    new CustomEvent(SECURITY_TOAST_EVENT, {
      detail: {
        id: `code-review-read:${Date.now()}:${Math.random().toString(36).slice(2)}`,
        title,
        message,
        variant,
        durationMs: variant === 'error' ? 7000 : 5000,
      },
    }),
  );
}

function numericDelay(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function getAutomationState(): AutomationState {
  const automation = window.__mcpAutomationState;
  if (automation) {
    return {
      autoExecute: automation.autoExecute === true,
      autoInsert: automation.autoInsert === true,
      autoSubmit: automation.autoSubmit === true,
      autoInsertDelay: numericDelay(automation.autoInsertDelay),
      autoSubmitDelay: numericDelay(automation.autoSubmitDelay),
    };
  }

  const legacy = window.toggleState;
  return {
    autoExecute: legacy?.autoExecute === true,
    autoInsert: legacy?.autoInsert === true,
    autoSubmit: legacy?.autoSubmit === true,
    autoInsertDelay: 0,
    autoSubmitDelay: 0,
  };
}

function generalAutoExecuteEnabled(): boolean {
  return getAutomationState().autoExecute;
}

function parseJsonLines(text: string): any[] {
  const parsed: any[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith('{') || !line.endsWith('}')) continue;
    try {
      const value = JSON.parse(line);
      if (value && typeof value === 'object') parsed.push(value);
    } catch {
      // Streaming/incomplete lines are retried after the next DOM mutation.
    }
  }
  return parsed;
}

function parseApprovedReadCall(text: string): ParsedReadCall | null {
  const items = parseJsonLines(text);
  const start = items.find(
    item => item?.type === 'function_call_start' && typeof item?.name === 'string' && READ_TOOL_NAMES.has(item.name),
  );
  if (!start) return null;

  const callId = String(start.call_id ?? '');
  if (!callId) return null;

  const complete = items.some(
    item => item?.type === 'function_call_end' && String(item?.call_id ?? '') === callId,
  );
  if (!complete) return null;

  const args: Record<string, unknown> = {};
  for (const item of items) {
    if (item?.type !== 'parameter' || typeof item?.key !== 'string') continue;
    args[item.key] = item.value;
  }

  return { toolName: start.name, callId, args };
}

function callKey(call: ParsedReadCall): string {
  const sortedArgs = Object.keys(call.args)
    .sort()
    .reduce<Record<string, unknown>>((acc, key) => {
      acc[key] = call.args[key];
      return acc;
    }, {});
  return `${window.location.pathname}|${call.toolName}|${call.callId}|${JSON.stringify(sortedArgs)}`;
}

function getCurrentAdapter(): any {
  try {
    const registry = window.pluginRegistry;
    if (registry && typeof registry.getActivePlugin === 'function') {
      const active = registry.getActivePlugin();
      if (active) return active;
    }
  } catch {
    // Fall through to the legacy adapter.
  }
  return window.mcpAdapter || window.getCurrentAdapter?.() || null;
}

async function getOriginSession(): Promise<StatusResponse['originSession']> {
  const response = (await chrome.runtime.sendMessage({ type: REVIEW_STATUS_MESSAGE })) as StatusResponse;
  if (!response?.success || !response.originSession) return null;
  if (
    typeof response.currentTabId === 'number' &&
    typeof response.originSession.approvedTabId === 'number' &&
    response.originSession.approvedTabId !== response.currentTabId
  ) {
    return null;
  }
  if (response.originSession.expiresAt && Date.now() >= response.originSession.expiresAt) return null;
  return response.originSession;
}

async function waitFor<T>(probe: () => T | null, timeoutMs: number, intervalMs = 100): Promise<T> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = probe();
    if (value) return value;
    await new Promise(resolve => window.setTimeout(resolve, intervalMs));
  }
  throw new Error('زمان انتظار برای تکمیل مسیر اصلی اجرای MCP به پایان رسید.');
}

function getResultPanel(block: HTMLElement, callId: string): HTMLElement | null {
  return (
    Array.from(block.querySelectorAll<HTMLElement>('.function-results-panel[data-call-id]')).find(
      panel => panel.getAttribute('data-call-id') === callId,
    ) || null
  );
}

async function submitConversation(): Promise<void> {
  const adapter = getCurrentAdapter();
  if (!adapter || typeof adapter.submitForm !== 'function') {
    throw new Error('آداپتر چت برای ارسال نتیجه ابزار آماده نیست.');
  }
  const submitted = await adapter.submitForm();
  if (!submitted) throw new Error('ارسال نتیجه ابزار GitHub برای مدل ناموفق بود.');
}

async function forwardSuccessfulResult(block: HTMLElement, call: ParsedReadCall): Promise<void> {
  const automation = getAutomationState();

  // If upstream automation already owns both insert and submit, do not race it.
  if (automation.autoInsert && automation.autoSubmit) {
    const delayMs = (automation.autoInsertDelay + automation.autoSubmitDelay) * 1000 + 1200;
    if (delayMs > 0) await new Promise(resolve => window.setTimeout(resolve, delayMs));
    return;
  }

  if (automation.autoInsert) {
    // Let upstream AutomationService perform the insertion, then only supply the
    // missing submit step for the approved Code Review session.
    const delayMs = automation.autoInsertDelay * 1000 + 350;
    if (delayMs > 0) await new Promise(resolve => window.setTimeout(resolve, delayMs));
    if (!(await getOriginSession())) throw new Error('نشست Code Review پیش از ارسال نتیجه پایان یافت.');
    await submitConversation();
    return;
  }

  // Auto Insert is OFF. Use the renderer's own Insert button so formatting,
  // adapter selection, history, and compatibility behavior remain upstream-owned.
  const insertButton = await waitFor<HTMLButtonElement>(
    () => block.querySelector<HTMLButtonElement>('.insert-result-button'),
    5000,
  );

  if (!insertButton.disabled) insertButton.click();

  await waitFor<HTMLElement>(
    () =>
      insertButton.classList.contains('insert-success') || (insertButton.textContent || '').includes('Inserted!')
        ? insertButton
        : null,
    5000,
  );

  if (!(await getOriginSession())) throw new Error('نشست Code Review پیش از ارسال نتیجه پایان یافت.');

  // AutomationService only auto-submits after its own auto-insert succeeds. Since
  // we intentionally used the renderer's manual Insert path, submit explicitly.
  await submitConversation();
}

async function executeReadThroughUpstream(source: HTMLElement, call: ParsedReadCall): Promise<void> {
  const key = callKey(call);
  if (completedCalls.has(key) || inFlightCalls.has(key)) return;

  const block = source.closest<HTMLElement>('.function-block');
  if (!block) return;

  inFlightCalls.add(key);
  source.setAttribute('data-code-review-read-executing', 'true');

  try {
    const session = await getOriginSession();
    if (!session?.id) return;

    const automation = getAutomationState();
    let resultPanel = getResultPanel(block, call.callId);
    let successNode = resultPanel?.querySelector<HTMLElement>('.function-result-success') || null;
    let errorNode = resultPanel?.querySelector<HTMLElement>('.function-result-error') || null;

    if (!successNode && !errorNode && !automation.autoExecute) {
      const executeButton = block.querySelector<HTMLButtonElement>('.execute-button');
      if (!executeButton) throw new Error('دکمه Run اصلی MCP برای این فراخوانی پیدا نشد.');

      if (!executeButton.disabled) {
        block.setAttribute('data-code-review-upstream-run', call.callId);
        executeButton.click();
      }
    }

    resultPanel = await waitFor<HTMLElement>(() => getResultPanel(block, call.callId), 5000);

    const outcome = await waitFor<{ success?: HTMLElement; error?: HTMLElement }>(() => {
      const success = resultPanel?.querySelector<HTMLElement>('.function-result-success') || null;
      if (success) return { success };
      const error = resultPanel?.querySelector<HTMLElement>('.function-result-error') || null;
      if (error) return { error };
      return null;
    }, 30000);

    if (outcome.error) {
      throw new Error((outcome.error.textContent || '').trim() || `اجرای ${call.toolName} در مسیر اصلی MCP ناموفق بود.`);
    }

    if (!(await getOriginSession())) throw new Error('نشست Code Review پیش از برگشت نتیجه پایان یافت.');

    await forwardSuccessfulResult(block, call);

    completedCalls.add(key);
    source.setAttribute('data-code-review-read-executed', 'true');
    block.setAttribute('data-code-review-read-complete', call.callId);
    attemptsBySource.delete(source);

    emitRuntimeToast(
      'نتیجه GitHub به مدل برگشت',
      `${call.toolName} از مسیر اصلی MCP اجرا شد و نتیجه برای ادامه بررسی به همین گفتگو ارسال شد.`,
      'success',
    );
  } catch (error) {
    const attempts = (attemptsBySource.get(source) || 0) + 1;
    attemptsBySource.set(source, attempts);
    source.setAttribute('data-code-review-read-error', String(attempts));

    emitRuntimeToast(
      'اجرای ابزار Read-only GitHub ناموفق بود',
      error instanceof Error ? error.message : String(error),
      'error',
    );

    if (attempts < 3 && !disposed) {
      window.setTimeout(scheduleScan, attempts * 900);
    }
  } finally {
    inFlightCalls.delete(key);
    source.removeAttribute('data-code-review-read-executing');
  }
}

function scan(): void {
  if (disposed) return;

  // The renderer stores authoritative model-produced JSON in this hidden panel.
  // We only use it to identify the approved read call; actual execution and result
  // insertion go through the renderer's native Run/Insert pipeline.
  document.querySelectorAll<HTMLElement>('.function-block .xml-results-panel pre').forEach(source => {
    if (source.getAttribute('data-code-review-read-executed') === 'true') return;
    if (source.getAttribute('data-code-review-read-executing') === 'true') return;

    const call = parseApprovedReadCall(source.textContent || '');
    if (!call) return;
    void executeReadThroughUpstream(source, call);
  });
}

function scheduleScan(): void {
  if (scanScheduled || disposed) return;
  scanScheduled = true;
  queueMicrotask(() => {
    scanScheduled = false;
    scan();
  });
}

function install(): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (window.__mcpCodeReviewReadExecutorInstalled) return;
  window.__mcpCodeReviewReadExecutorInstalled = true;
  disposed = false;

  const start = () => {
    scan();
    observer = new MutationObserver(scheduleScan);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });

    // Approval and automation state can change without a DOM mutation.
    window.setInterval(scheduleScan, 500);
  };

  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
}

install();

export const codeReviewReadExecutorTestUtils = {
  generalAutoExecuteEnabled,
  getAutomationState,
  parseApprovedReadCall,
};
