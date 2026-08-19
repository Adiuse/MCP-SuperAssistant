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

const MAX_EXECUTION_ATTEMPTS = 3;
const MAX_RESULT_SUBMIT_ATTEMPTS = 3;
const GITHUB_DEVICE_LOGIN_URL = 'https://github.com/login/device';
const CHAT_INPUT_SELECTOR =
  '#prompt-textarea, .ProseMirror[contenteditable="true"], div[contenteditable="true"][data-id*="prompt"]';

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
};

type GitHubDeviceAuthChallenge = {
  verificationUrl: string;
  userCode?: string;
};

type CachedReadResult = {
  key: string;
  result: unknown;
};

declare global {
  interface Window {
    __mcpCodeReviewReadExecutorInstalled?: boolean;
    __mcpAutomationState?: {
      autoExecute?: boolean;
    };
    toggleState?: {
      autoExecute?: boolean;
    };
    pluginRegistry?: any;
    mcpAdapter?: any;
    getCurrentAdapter?: () => any;
    mcpClient?: {
      isReady?: () => boolean;
      callTool?: (toolName: string, args: Record<string, unknown>) => Promise<unknown>;
    };
  }
}

const completedCalls = new Set<string>();
const inFlightCalls = new Set<string>();
const attemptsBySource = new WeakMap<HTMLElement, number>();
const retryAfterBySource = new WeakMap<HTMLElement, number>();
const resultBySource = new WeakMap<HTMLElement, CachedReadResult>();
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

function getAutomationState(): AutomationState {
  const automation = window.__mcpAutomationState;
  if (automation) {
    return { autoExecute: automation.autoExecute === true };
  }

  const legacy = window.toggleState;
  return { autoExecute: legacy?.autoExecute === true };
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

function resultToText(result: unknown): string {
  if (result && typeof result === 'object') {
    const content = (result as any).content;
    if (Array.isArray(content)) {
      const textParts: string[] = [];

      for (const item of content) {
        if (item?.type === 'text' && typeof item?.text === 'string') {
          textParts.push(item.text);
          continue;
        }

        // GitHub MCP get_file_contents returns the actual file body as an
        // embedded MCP resource. The accompanying text item contains only a
        // success/SHA message, so dropping resource.text makes the model believe
        // it read the file while receiving none of its contents.
        if (item?.type === 'resource' && typeof item?.resource?.text === 'string') {
          textParts.push(item.resource.text);
        }
      }

      if (textParts.length > 0) return textParts.join('\n\n');
    }

    try {
      return JSON.stringify(result, null, 2);
    } catch {
      return String(result);
    }
  }

  return String(result ?? '');
}

function parseGitHubDeviceAuthChallenge(result: unknown): GitHubDeviceAuthChallenge | null {
  const text = resultToText(result);
  if (!text.includes(GITHUB_DEVICE_LOGIN_URL)) return null;
  if (!/authorize the GitHub MCP Server|device[- ]code|enter the code/i.test(text)) return null;

  const codeMatch = text.match(/enter the code\s+([A-Z0-9-]+)/i);
  return {
    verificationUrl: GITHUB_DEVICE_LOGIN_URL,
    userCode: codeMatch?.[1],
  };
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

async function executeThroughSharedMcpClient(call: ParsedReadCall): Promise<unknown> {
  const mcpClient = window.mcpClient;
  if (!mcpClient || typeof mcpClient.callTool !== 'function') {
    throw new Error('MCP client اصلی صفحه آماده نیست.');
  }
  if (typeof mcpClient.isReady === 'function' && !mcpClient.isReady()) {
    throw new Error('MCP client اصلی هنوز آماده اجرای ابزار نیست.');
  }

  // This is the same execution API used by the renderer's native Run button.
  // The MCP client itself remains responsible for Gate enforcement, repo scope,
  // origin binding, limits, alias mapping, and the actual server call.
  return await mcpClient.callTool(call.toolName, call.args);
}

function currentComposerText(): string {
  const input = document.querySelector<HTMLElement>(CHAT_INPUT_SELECTOR);
  return input?.textContent || '';
}

function composerContainsResult(callId: string): boolean {
  return currentComposerText().includes(`<function_result call_id="${callId}">`);
}

async function wait(ms: number): Promise<void> {
  await new Promise(resolve => window.setTimeout(resolve, ms));
}

async function submitInsertedResult(adapter: any, callId: string): Promise<void> {
  // Let ChatGPT/other adapters observe the synthetic input event before the
  // send click. A submitForm() true return only means a button was clicked, not
  // that the host actually accepted and cleared the composer.
  await wait(180);

  for (let attempt = 1; attempt <= MAX_RESULT_SUBMIT_ATTEMPTS; attempt += 1) {
    const submitted = await adapter.submitForm();
    if (submitted) {
      await wait(450);
      if (!composerContainsResult(callId)) return;
    }

    if (attempt < MAX_RESULT_SUBMIT_ATTEMPTS) {
      const input = document.querySelector<HTMLElement>(CHAT_INPUT_SELECTOR);
      input?.focus();
      input?.dispatchEvent(new Event('input', { bubbles: true }));
      await wait(180 * attempt);
    }
  }

  throw new Error('نتیجه GitHub داخل کادر پیام ماند و ارسال آن به مدل تأیید نشد.');
}

async function returnResultToConversation(call: ParsedReadCall, result: unknown): Promise<void> {
  if (!(await getOriginSession())) {
    throw new Error('نشست Code Review پیش از برگشت نتیجه پایان یافت.');
  }

  const adapter = getCurrentAdapter();
  if (!adapter || typeof adapter.insertText !== 'function' || typeof adapter.submitForm !== 'function') {
    throw new Error('آداپتر چت برای برگرداندن نتیجه ابزار آماده نیست.');
  }

  const wrapper = `<function_result call_id="${call.callId}">\n${resultToText(result)}\n</function_result>`;

  // If a previous delivery attempt left the exact function result in the
  // composer, retry only submission. Never append a duplicate wrapper.
  if (!composerContainsResult(call.callId)) {
    const inserted = await adapter.insertText(wrapper);
    if (!inserted) throw new Error('نتیجه ابزار GitHub در گفتگو درج نشد.');
  }

  await submitInsertedResult(adapter, call.callId);
}

async function executeApprovedRead(source: HTMLElement, call: ParsedReadCall): Promise<void> {
  const key = callKey(call);
  if (completedCalls.has(key) || inFlightCalls.has(key)) return;
  if (source.getAttribute('data-code-review-read-final-error') === 'true') return;

  const retryAfter = retryAfterBySource.get(source) || 0;
  if (retryAfter > Date.now()) return;

  inFlightCalls.add(key);
  source.setAttribute('data-code-review-read-executing', 'true');

  try {
    const session = await getOriginSession();
    if (!session?.id) return;

    const cached = resultBySource.get(source);
    let result: unknown;

    if (cached?.key === key) {
      result = cached.result;
    } else {
      result = await executeThroughSharedMcpClient(call);
      const authChallenge = parseGitHubDeviceAuthChallenge(result);

      if (authChallenge) {
        source.setAttribute('data-code-review-read-auth-required', 'true');
        source.setAttribute('data-code-review-read-final-error', 'true');
        retryAfterBySource.delete(source);
        attemptsBySource.delete(source);

        emitRuntimeToast(
          'GitHub MCP نیاز به احراز هویت دارد',
          'GitHub MCP به‌جای محتوای مخزن، Device Login برگرداند. کد ورود برای امنیت به مدل ارسال نشد. GITHUB_PERSONAL_ACCESS_TOKEN را در محیط Proxy/Container تنظیم کنید و سپس درخواست مخزن را دوباره اجرا کنید.',
          'warning',
        );
        return;
      }

      // Cache the already-authorized GitHub response before delivery. If the
      // host composer temporarily fails to submit, retries must not spend a
      // second Gate call or re-read GitHub.
      resultBySource.set(source, { key, result });
    }

    if (!(await getOriginSession())) {
      throw new Error('نشست Code Review پیش از برگشت نتیجه پایان یافت.');
    }

    await returnResultToConversation(call, result);

    completedCalls.add(key);
    resultBySource.delete(source);
    source.setAttribute('data-code-review-read-executed', 'true');
    source.removeAttribute('data-code-review-read-error');
    retryAfterBySource.delete(source);
    attemptsBySource.delete(source);

    emitRuntimeToast(
      'نتیجه GitHub به مدل برگشت',
      `${call.toolName} از MCP client اصلی اجرا شد و نتیجه برای ادامه بررسی به همین گفتگو ارسال شد.`,
      'success',
    );
  } catch (error) {
    const stillActive = await getOriginSession().catch(() => null);
    if (!stillActive) return;

    const attempts = (attemptsBySource.get(source) || 0) + 1;
    attemptsBySource.set(source, attempts);
    source.setAttribute('data-code-review-read-error', String(attempts));

    if (attempts < MAX_EXECUTION_ATTEMPTS && !disposed) {
      const retryDelay = attempts * 900;
      retryAfterBySource.set(source, Date.now() + retryDelay);
      window.setTimeout(scheduleScan, retryDelay + 25);
      return;
    }

    source.setAttribute('data-code-review-read-final-error', 'true');
    retryAfterBySource.delete(source);

    emitRuntimeToast(
      'اجرای ابزار Read-only GitHub ناموفق بود',
      error instanceof Error ? error.message : String(error),
      'error',
    );
  } finally {
    inFlightCalls.delete(key);
    source.removeAttribute('data-code-review-read-executing');
  }
}

function scan(): void {
  if (disposed || generalAutoExecuteEnabled()) return;

  // The renderer stores authoritative model-produced JSON in this hidden panel.
  // It is used only to identify the real completed read call. Execution itself
  // goes through window.mcpClient.callTool, exactly like the renderer Run path.
  document.querySelectorAll<HTMLElement>('.function-block .xml-results-panel pre').forEach(source => {
    if (source.getAttribute('data-code-review-read-executed') === 'true') return;
    if (source.getAttribute('data-code-review-read-executing') === 'true') return;
    if (source.getAttribute('data-code-review-read-final-error') === 'true') return;

    const retryAfter = retryAfterBySource.get(source) || 0;
    if (retryAfter > Date.now()) return;

    const call = parseApprovedReadCall(source.textContent || '');
    if (!call) return;
    void executeApprovedRead(source, call);
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

    // Approval, MCP readiness, and automation state can change without a DOM mutation.
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
  parseGitHubDeviceAuthChallenge,
  resultToText,
};