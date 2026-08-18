import { useEffect, useMemo, useRef } from 'react';
import { useAvailableTools, useCurrentAdapter, useUserPreferences } from '../../../hooks';
import { useMcpCommunication } from '../../../hooks/useMcpCommunication';
import { createLogger } from '@extension/shared/lib/logger';
import { generateInstructionsJson } from './instructionGeneratorJson';
import { instructionsState } from './InstructionManager';
import { SecurityToastContainer } from '../../mcpPopover/SecurityToastContainer';
import { emitSecurityToast } from '../../mcpPopover/securityToast';

const logger = createLogger('HeadlessInstructionSync');
const REVIEW_REQUEST_TOOL = 'request_code_review_access';
const RESUMED_SESSIONS_KEY = 'mcpCodeReviewResumedSessionIds';
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
const READ_TOOL_PATTERN = /###\s+(get_me|get_file_contents|get_repository_tree|search_code|list_commits|get_commit|get_file_blame|list_branches|list_tags|get_tag|list_pull_requests|pull_request_read)\b/;

interface PendingReviewRequest {
  id?: string;
  owner?: string;
  repo?: string;
  durationMinutes?: number;
  requestedAt?: number;
  sourcePath?: string;
  sourceTabId?: number;
}

interface ReviewSession {
  id?: string;
  owner?: string;
  repo?: string;
  durationMinutes?: number;
  approvedTabId?: number;
  sourcePath?: string;
  sourceRequestId?: string;
  startedAt?: number;
  expiresAt?: number;
}

interface ReviewStatusResponse {
  success?: boolean;
  currentTabId?: number;
  session?: ReviewSession | null;
  pendingRequests?: PendingReviewRequest[];
  pendingRequest?: PendingReviewRequest | null;
}

interface ReviewAuditEntry {
  timestamp?: number;
  action?: string;
  toolName?: string;
  owner?: string;
  repo?: string;
  reason?: string;
  resource?: string;
}

interface ReviewAuditResponse {
  success?: boolean;
  entries?: ReviewAuditEntry[];
}

type ResumeAttempt = { count: number; nextAt: number };

const resumeInFlightSessions = new Set<string>();
const resumeAttempts = new Map<string, ResumeAttempt>();

function currentConversationPath(): string {
  return `${window.location.pathname}${window.location.search}`;
}

function parseJsonObjects(text: string): any[] {
  const objects: any[] = [];
  const matches = text.match(/\{[^{}]*\}/gs) || [];

  for (const candidate of matches) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object') objects.push(parsed);
    } catch {
      // Streaming may leave a partial JSON object. The next DOM mutation will retry.
    }
  }

  return objects;
}

function containsReviewRequestCall(text: string): boolean {
  if (!text || !/"name"\s*:\s*"request_code_review_access"/.test(text)) return false;
  return parseJsonObjects(text).some(
    item => item?.type === 'function_call_start' && item?.name === REVIEW_REQUEST_TOOL,
  );
}

function findRenderedReviewBlocks(owner?: string, repo?: string): HTMLElement[] {
  const all = Array.from(document.querySelectorAll<HTMLElement>('.function-block')).filter(block =>
    (block.textContent || '').includes(REVIEW_REQUEST_TOOL),
  );

  if (!owner || !repo) return all.slice(-1);

  const exact = all.filter(block => {
    const text = (block.textContent || '').toLowerCase();
    return text.includes(owner.toLowerCase()) && text.includes(repo.toLowerCase());
  });

  return exact.length > 0 ? exact : all.slice(-1);
}

function setRenderedReviewState(
  request: { owner?: string; repo?: string; durationMinutes?: number },
  state: 'pending' | 'approved',
): void {
  const owner = request.owner || 'GitHub';
  const repo = request.repo || 'repository';
  const duration = Number(request.durationMinutes) || 0;
  const blocks = findRenderedReviewBlocks(request.owner, request.repo);

  for (const block of blocks) {
    block.setAttribute('data-review-approval-state', state);

    let status = block.querySelector<HTMLElement>('[data-review-status]');
    if (!status) {
      status = document.createElement('div');
      status.setAttribute('data-review-status', 'true');
      status.style.marginTop = '12px';
      status.style.padding = '10px 12px';
      status.style.borderRadius = '8px';
      status.style.fontSize = '13px';
      status.style.fontWeight = '600';
      status.style.lineHeight = '1.5';
      block.appendChild(status);
    }

    if (state === 'pending') {
      status.textContent = `در انتظار تأیید شما برای ${owner}/${repo}${duration ? ` — ${duration} دقیقه` : ''}`;
      status.style.background = 'rgba(245, 158, 11, 0.14)';
      status.style.border = '1px solid rgba(245, 158, 11, 0.45)';
      status.style.color = 'inherit';
      continue;
    }

    status.textContent = `✓ دسترسی ${owner}/${repo} تأیید و فعال شد`;
    status.style.background = 'rgba(16, 185, 129, 0.14)';
    status.style.border = '1px solid rgba(16, 185, 129, 0.45)';
    status.style.color = 'inherit';

    block.querySelectorAll<HTMLButtonElement>('button').forEach(button => {
      const label = (button.textContent || '').trim().toLowerCase();
      if (label === 'run' || label === 're-execute' || label.includes('re-execute')) {
        button.disabled = true;
        button.style.opacity = '0.45';
        button.style.cursor = 'not-allowed';
      }
    });
  }
}

function auditFingerprint(entry: ReviewAuditEntry): string {
  return [
    entry.timestamp || 0,
    entry.action || '',
    entry.toolName || '',
    entry.owner || '',
    entry.repo || '',
    entry.reason || '',
    entry.resource || '',
  ].join('|');
}

function emitToastForAuditEntry(entry: ReviewAuditEntry): void {
  const target = entry.owner && entry.repo ? `${entry.owner}/${entry.repo}` : '';

  switch (entry.action) {
    case 'access_requested':
      emitSecurityToast({
        id: `access-requested:${entry.timestamp || Date.now()}`,
        title: 'تأیید Code Review لازم است',
        message: target || 'یک درخواست دسترسی Read-only منتظر تأیید است.',
        variant: 'warning',
      });
      break;
    case 'session_started':
      emitSecurityToast({
        id: `session-started:${entry.timestamp || Date.now()}`,
        title: 'دسترسی GitHub فعال شد',
        message: target ? `${target} در حالت فقط‌خواندنی فعال شد.` : 'نشست Code Review فعال شد.',
        variant: 'success',
      });
      break;
    case 'session_revoked':
      emitSecurityToast({
        id: `session-revoked:${entry.timestamp || Date.now()}`,
        title: 'دسترسی GitHub لغو شد',
        message: target ? `دسترسی ${target} فوراً غیرفعال شد.` : 'نشست Code Review لغو شد.',
        variant: 'info',
      });
      break;
    case 'session_expired':
      emitSecurityToast({
        id: `session-expired:${entry.timestamp || Date.now()}`,
        title: 'زمان دسترسی پایان یافت',
        message: target ? `دسترسی ${target} منقضی شد.` : 'نشست Code Review منقضی شد.',
        variant: 'warning',
      });
      break;
    case 'access_rejected':
      emitSecurityToast({
        id: `access-rejected:${entry.timestamp || Date.now()}`,
        title: 'درخواست دسترسی رد شد',
        message: target || entry.reason || 'درخواست Code Review رد شد.',
        variant: 'warning',
      });
      break;
    case 'tool_denied':
    case 'response_denied':
      emitSecurityToast({
        id: `security-denied:${entry.timestamp || Date.now()}:${entry.toolName || entry.action}`,
        title: 'درخواست امنیتی مسدود شد',
        message:
          [entry.toolName, entry.resource, entry.reason].filter(Boolean).join(' — ') ||
          'Gate این عملیات را مسدود کرد.',
        variant: 'error',
        durationMs: 6500,
      });
      break;
    case 'notification_failed':
      emitSecurityToast({
        id: `notification-failed:${entry.timestamp || Date.now()}`,
        title: 'ثبت اعلان امنیتی ناموفق بود',
        message: entry.reason || 'وضعیت امنیتی داخل MCP همچنان معتبر است.',
        variant: 'warning',
      });
      break;
    default:
      break;
  }
}

async function hasResumeMarker(sessionId: string): Promise<boolean> {
  const stored = await chrome.storage.local.get(RESUMED_SESSIONS_KEY);
  const ids = Array.isArray(stored[RESUMED_SESSIONS_KEY]) ? stored[RESUMED_SESSIONS_KEY] : [];
  return ids.includes(sessionId);
}

async function markSessionResumed(sessionId: string): Promise<void> {
  const stored = await chrome.storage.local.get(RESUMED_SESSIONS_KEY);
  const ids = Array.isArray(stored[RESUMED_SESSIONS_KEY]) ? stored[RESUMED_SESSIONS_KEY] : [];
  const next = [...ids.filter((id: unknown) => typeof id === 'string' && id !== sessionId), sessionId].slice(-50);
  await chrome.storage.local.set({ [RESUMED_SESSIONS_KEY]: next });
}

async function waitForReadInstructions(timeoutMs = 6000): Promise<string> {
  const startedAt = Date.now();
  let latest = instructionsState.instructions || '';

  while (Date.now() - startedAt < timeoutMs) {
    latest = instructionsState.instructions || latest;
    if (READ_TOOL_PATTERN.test(latest)) return latest;
    await new Promise(resolve => window.setTimeout(resolve, 100));
  }

  return latest;
}

export function HeadlessInstructionSync() {
  const { tools, setAvailableTools } = useAvailableTools();
  const { preferences } = useUserPreferences();
  const { isInitialized, isConnected, refreshTools } = useMcpCommunication();
  const { insertText, submitForm, isReady } = useCurrentAdapter();

  const refreshedForConnection = useRef(false);
  const lastSessionId = useRef<string | null | undefined>(undefined);
  const toolsRef = useRef(tools);
  const adapterRef = useRef({ insertText, submitForm, isReady });
  const seenAuditEntries = useRef<Set<string>>(new Set());
  const auditSeeded = useRef(false);

  useEffect(() => {
    toolsRef.current = tools;
  }, [tools]);

  useEffect(() => {
    adapterRef.current = { insertText, submitForm, isReady };
  }, [insertText, submitForm, isReady]);

  useEffect(() => {
    if (!isInitialized || !isConnected || refreshedForConnection.current) return;

    refreshedForConnection.current = true;
    void refreshTools(true).catch(error => {
      refreshedForConnection.current = false;
      logger.warn(
        '[HeadlessInstructionSync] Initial tool refresh failed:',
        error instanceof Error ? error.message : String(error),
      );
    });
  }, [isConnected, isInitialized, refreshTools]);

  useEffect(() => {
    if (!isConnected) refreshedForConnection.current = false;
  }, [isConnected]);

  useEffect(() => {
    if (!isInitialized || !isConnected) return;

    let disposed = false;
    let scanScheduled = false;
    let statusSyncBusy = false;

    const maybeResumeOriginSession = async (
      session: ReviewSession,
      currentTabId: number | undefined,
      preferredTools?: Array<{ name?: string }>,
    ) => {
      const sessionId = session.id;
      if (!sessionId || currentTabId === undefined || session.approvedTabId !== currentTabId) return;
      if (resumeInFlightSessions.has(sessionId)) return;
      if (await hasResumeMarker(sessionId)) return;

      const previousAttempt = resumeAttempts.get(sessionId);
      if (previousAttempt && (previousAttempt.count >= 3 || Date.now() < previousAttempt.nextAt)) return;

      const attemptCount = (previousAttempt?.count || 0) + 1;
      resumeAttempts.set(sessionId, { count: attemptCount, nextAt: Date.now() + attemptCount * 2000 });
      resumeInFlightSessions.add(sessionId);

      try {
        const currentTools = preferredTools || (await refreshTools(true));
        const hasReadTools = currentTools.some(tool => tool?.name && READ_TOOL_NAMES.has(tool.name));
        if (!hasReadTools) {
          throw new Error('نشست فعال است اما ابزارهای Read-only GitHub برای تب مبدأ دریافت نشدند.');
        }

        const updatedInstructions = await waitForReadInstructions();
        if (!READ_TOOL_PATTERN.test(updatedInstructions)) {
          throw new Error('لیست ابزارها دریافت شد اما Instructions مدل هنوز با ابزارهای Read-only همگام نشده است.');
        }

        const adapter = adapterRef.current;
        if (!adapter.isReady) throw new Error('آداپتر چت برای ادامه خودکار آماده نیست.');

        const owner = session.owner || 'GitHub';
        const repo = session.repo || 'repository';
        const duration = Number(session.durationMinutes) || 0;
        const continuation = `${updatedInstructions}\n\n[MCP Approval Result] Code Review access is approved and active for ${owner}/${repo}${duration ? ` for ${duration} minutes` : ''}. Continue the user's pending repository task now using the exposed read-only MCP tools. Do not request access again unless this session expires or is revoked.`;

        const inserted = await adapter.insertText(continuation);
        if (!inserted) throw new Error('درج پیام ادامه در چت ناموفق بود.');

        const submitted = await adapter.submitForm();
        if (!submitted) throw new Error('ارسال خودکار پیام ادامه ناموفق بود.');

        await markSessionResumed(sessionId);
        resumeAttempts.delete(sessionId);
        emitSecurityToast({
          id: `review-resumed:${sessionId}`,
          title: 'بررسی کد ادامه پیدا کرد',
          message: `${owner}/${repo} — ابزارهای Read-only به مدل اعلام شدند.`,
          variant: 'success',
        });
      } catch (error) {
        emitSecurityToast({
          id: `review-resume-failed:${sessionId}:${attemptCount}`,
          title: 'ادامه خودکار Code Review ناموفق بود',
          message: error instanceof Error ? error.message : String(error),
          variant: 'warning',
          durationMs: 6500,
        });
      } finally {
        resumeInFlightSessions.delete(sessionId);
      }
    };

    const scan = () => {
      if (disposed) return;
      document.querySelectorAll<HTMLElement>('pre').forEach(source => {
        if (source.getAttribute('data-review-request-observed') === 'true') return;
        if (source.closest('.function-block')) return;
        if (!containsReviewRequestCall(source.textContent || '')) return;
        source.setAttribute('data-review-request-observed', 'true');
      });
    };

    const syncApprovalState = async () => {
      if (disposed || statusSyncBusy) return;
      statusSyncBusy = true;

      try {
        const response = (await chrome.runtime.sendMessage({
          type: 'code-review:get-status',
        })) as ReviewStatusResponse;
        if (!response?.success) return;

        const pendingRequests = Array.isArray(response.pendingRequests)
          ? response.pendingRequests
          : response.pendingRequest
            ? [response.pendingRequest]
            : [];
        const session = response.session || null;
        const currentTabId = response.currentTabId;
        const path = currentConversationPath();

        const currentPending = [...pendingRequests]
          .reverse()
          .find(request => !request.sourcePath || request.sourcePath === path);
        if (currentPending) setRenderedReviewState(currentPending, 'pending');

        if (session && (session.approvedTabId === currentTabId || session.sourcePath === path)) {
          setRenderedReviewState(session, 'approved');
        }

        const sessionId = session?.id || null;
        const sessionChanged = lastSessionId.current === undefined || lastSessionId.current !== sessionId;
        lastSessionId.current = sessionId;

        const currentTools = toolsRef.current;
        const hasReadTools = currentTools.some(tool => READ_TOOL_NAMES.has(tool.name));
        const hasRequestTool = currentTools.some(tool => tool.name === REVIEW_REQUEST_TOOL);
        const sessionIsForThisTab = Boolean(
          session && currentTabId !== undefined && session.approvedTabId === currentTabId,
        );

        let refreshedTools: Array<{ name?: string }> | undefined;

        if (session && !sessionIsForThisTab) {
          // Legacy background broadcasts are global. Do not let a read-tool list
          // from another tab leak into this chat's model instructions.
          if (currentTools.length > 0) {
            setAvailableTools([]);
            toolsRef.current = [];
          }
        } else {
          const toolScopeMismatch = session ? !hasReadTools : !hasRequestTool;
          if (sessionChanged || toolScopeMismatch) {
            try {
              refreshedTools = await refreshTools(true);
            } catch (error) {
              logger.debug(
                '[HeadlessInstructionSync] Gated tool refresh failed:',
                error instanceof Error ? error.message : String(error),
              );
            }
          }
        }

        if (session && sessionIsForThisTab) {
          await maybeResumeOriginSession(session, currentTabId, refreshedTools);
        }
      } catch (error) {
        logger.debug(
          '[HeadlessInstructionSync] Approval-state sync skipped:',
          error instanceof Error ? error.message : String(error),
        );
      } finally {
        statusSyncBusy = false;
      }
    };

    const syncSecurityToasts = async () => {
      if (disposed) return;

      try {
        const response = (await chrome.runtime.sendMessage({
          type: 'code-review:get-audit',
        })) as ReviewAuditResponse;
        if (!response?.success || !Array.isArray(response.entries)) return;

        if (!auditSeeded.current) {
          response.entries.forEach(entry => seenAuditEntries.current.add(auditFingerprint(entry)));
          auditSeeded.current = true;
          return;
        }

        for (const entry of response.entries) {
          const fingerprint = auditFingerprint(entry);
          if (seenAuditEntries.current.has(fingerprint)) continue;
          seenAuditEntries.current.add(fingerprint);
          emitToastForAuditEntry(entry);
        }

        if (seenAuditEntries.current.size > 500) {
          seenAuditEntries.current = new Set(response.entries.map(auditFingerprint));
        }
      } catch (error) {
        logger.debug(
          '[HeadlessInstructionSync] Security-toast audit sync skipped:',
          error instanceof Error ? error.message : String(error),
        );
      }
    };

    const scheduleScan = () => {
      if (scanScheduled || disposed) return;
      scanScheduled = true;
      queueMicrotask(() => {
        scanScheduled = false;
        scan();
      });
    };

    scan();
    void syncApprovalState();
    void syncSecurityToasts();

    const observer = new MutationObserver(scheduleScan);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });

    const approvalPoll = window.setInterval(() => void syncApprovalState(), 500);
    const auditPoll = window.setInterval(() => void syncSecurityToasts(), 1000);

    return () => {
      disposed = true;
      observer.disconnect();
      window.clearInterval(approvalPoll);
      window.clearInterval(auditPoll);
    };
  }, [isConnected, isInitialized, refreshTools, setAvailableTools]);

  const instructionTools = useMemo(
    () =>
      tools.map(tool => ({
        name: tool.name,
        description: tool.description || '',
        schema:
          typeof (tool as any).schema === 'string'
            ? (tool as any).schema
            : JSON.stringify(tool.input_schema || {}),
      })),
    [tools],
  );

  const generatedInstructions = useMemo(
    () =>
      generateInstructionsJson(
        instructionTools,
        preferences.customInstructions || '',
        preferences.customInstructionsEnabled || false,
      ),
    [instructionTools, preferences.customInstructions, preferences.customInstructionsEnabled],
  );

  useEffect(() => {
    instructionsState.setInstructions(generatedInstructions);
    logger.debug(`[HeadlessInstructionSync] Synced instructions for ${instructionTools.length} exposed MCP tool(s)`);
  }, [generatedInstructions, instructionTools.length]);

  return <SecurityToastContainer />;
}
