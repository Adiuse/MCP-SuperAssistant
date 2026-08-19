const REVIEW_STATUS_MESSAGE = 'code-review:get-status';
const MCP_CALL_MESSAGE = 'mcp:call-tool';
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

type McpCallResponse = {
  success?: boolean;
  error?: string;
  payload?: unknown;
};

declare global {
  interface Window {
    __mcpCodeReviewReadExecutorInstalled?: boolean;
    __mcpAutomationState?: { autoExecute?: boolean };
    toggleState?: { autoExecute?: boolean };
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

function generalAutoExecuteEnabled(): boolean {
  const automation = window.__mcpAutomationState;
  if (automation && typeof automation.autoExecute === 'boolean') return automation.autoExecute;

  const legacy = window.toggleState;
  if (legacy && typeof legacy.autoExecute === 'boolean') return legacy.autoExecute;

  // Until the user's automation preference is initialized, leave execution to
  // the normal renderer. This prevents a race that could execute the same call twice.
  return true;
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
  return `${window.location.pathname}${window.location.search}|${call.toolName}|${call.callId}|${JSON.stringify(sortedArgs)}`;
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

function resultToText(result: unknown): string {
  if (result && typeof result === 'object') {
    const content = (result as any).content;
    if (Array.isArray(content)) {
      const textParts = content
        .filter(item => item?.type === 'text' && typeof item?.text === 'string')
        .map(item => item.text);
      if (textParts.length > 0) return textParts.join('\n');
    }

    try {
      return JSON.stringify(result, null, 2);
    } catch {
      return String(result);
    }
  }

  return String(result ?? '');
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

async function returnResultToConversation(call: ParsedReadCall, result: unknown): Promise<void> {
  const adapter = getCurrentAdapter();
  if (!adapter || typeof adapter.insertText !== 'function' || typeof adapter.submitForm !== 'function') {
    throw new Error('آداپتر چت برای برگرداندن نتیجه ابزار آماده نیست.');
  }

  const wrapper = `<function_result call_id="${call.callId}">\n${resultToText(result)}\n</function_result>`;
  const inserted = await adapter.insertText(wrapper);
  if (!inserted) throw new Error('نتیجه ابزار GitHub در گفتگو درج نشد.');

  const submitted = await adapter.submitForm();
  if (!submitted) throw new Error('نتیجه ابزار GitHub برای مدل ارسال نشد.');
}

async function executeReadCall(source: HTMLElement, call: ParsedReadCall): Promise<void> {
  const key = callKey(call);
  if (completedCalls.has(key) || inFlightCalls.has(key)) return;

  inFlightCalls.add(key);
  source.setAttribute('data-code-review-read-executing', 'true');

  try {
    const session = await getOriginSession();
    if (!session?.id) return;

    const response = (await chrome.runtime.sendMessage({
      type: MCP_CALL_MESSAGE,
      payload: {
        toolName: call.toolName,
        args: call.args,
        adapterName: window.location.hostname || 'chat',
      },
      origin: 'content',
      timestamp: Date.now(),
    })) as McpCallResponse;

    if (!response?.success) {
      throw new Error(response?.error || `اجرای ${call.toolName} ناموفق بود.`);
    }

    await returnResultToConversation(call, response.payload);
    completedCalls.add(key);
    source.setAttribute('data-code-review-read-executed', 'true');
    attemptsBySource.delete(source);

    emitRuntimeToast(
      'نتیجه GitHub به مدل برگشت',
      `${call.toolName} اجرا شد و نتیجه برای ادامه بررسی به همین گفتگو ارسال شد.`,
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
      window.setTimeout(scheduleScan, attempts * 750);
    }
  } finally {
    inFlightCalls.delete(key);
    source.removeAttribute('data-code-review-read-executing');
  }
}

function scan(): void {
  if (disposed || generalAutoExecuteEnabled()) return;

  document.querySelectorAll<HTMLElement>('pre').forEach(source => {
    if (source.closest('.function-block')) return;
    if (source.getAttribute('data-code-review-read-executed') === 'true') return;
    if (source.getAttribute('data-code-review-read-executing') === 'true') return;

    const call = parseApprovedReadCall(source.textContent || '');
    if (!call) return;
    void executeReadCall(source, call);
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

    // Automation state and approval state can change without a DOM mutation.
    window.setInterval(scheduleScan, 500);
  };

  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
}

install();

export const codeReviewReadExecutorTestUtils = {
  generalAutoExecuteEnabled,
  parseApprovedReadCall,
  resultToText,
};
