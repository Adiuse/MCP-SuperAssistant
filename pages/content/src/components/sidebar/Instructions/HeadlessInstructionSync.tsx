import { useEffect, useMemo, useRef } from 'react';
import { useAvailableTools, useUserPreferences } from '../../../hooks';
import { useMcpCommunication } from '../../../hooks/useMcpCommunication';
import { createLogger } from '@extension/shared/lib/logger';
import { generateInstructionsJson } from './instructionGeneratorJson';
import { instructionsState } from './InstructionManager';
import { SecurityToastContainer } from '../../mcpPopover/SecurityToastContainer';
import { emitSecurityToast } from '../../mcpPopover/securityToast';

const logger = createLogger('HeadlessInstructionSync');
const REVIEW_REQUEST_TOOL = 'request_code_review_access';
const ALLOWED_DURATIONS = new Set([5, 10, 20]);

interface ParsedReviewRequest {
  owner: string;
  repo: string;
  durationMinutes: 5 | 10 | 20;
}

interface PendingReviewRequest {
  id?: string;
  owner?: string;
  repo?: string;
  durationMinutes?: number;
  sourcePath?: string;
}

interface ReviewStatusResponse {
  success?: boolean;
  session?: {
    id?: string;
    owner?: string;
    repo?: string;
    durationMinutes?: number;
    sourcePath?: string;
  } | null;
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
      // Streaming may leave a partial object in the DOM. Ignore it until the
      // next mutation completes the JSON object.
    }
  }

  return objects;
}

function parseReviewRequest(text: string): ParsedReviewRequest | null {
  if (!text || !/"name"\s*:\s*"request_code_review_access"/.test(text)) return null;

  const objects = parseJsonObjects(text);
  const start = objects.find(item => item?.type === 'function_call_start' && item?.name === REVIEW_REQUEST_TOOL);
  if (!start) return null;

  const parameters = new Map<string, unknown>();
  for (const item of objects) {
    if (item?.type === 'parameter' && typeof item?.key === 'string') {
      parameters.set(item.key, item.value);
    }
  }

  const ownerValue = parameters.get('owner');
  const repoValue = parameters.get('repo');
  const durationValue = Number(parameters.get('durationMinutes'));
  const owner = typeof ownerValue === 'string' ? ownerValue.trim() : '';
  const repo = typeof repoValue === 'string' ? repoValue.trim() : '';

  if (!owner || !repo || !ALLOWED_DURATIONS.has(durationValue)) return null;

  return {
    owner,
    repo,
    durationMinutes: durationValue as 5 | 10 | 20,
  };
}

async function dispatchReviewRequest(request: ParsedReviewRequest): Promise<void> {
  // Route approval requests through the code-review control bridge instead of
  // the generic tool execution path. The bridge sees sender.tab and sender.tab.url,
  // so the global queue can retain the originating tab/conversation while still
  // being manageable from every other chat.
  const response = await chrome.runtime.sendMessage({
    type: 'code-review:request',
    payload: request,
  });

  if (!response?.success) {
    throw new Error(response?.error || 'Background rejected the Code Review approval request');
  }

  window.dispatchEvent(new CustomEvent('code-review:pending-updated'));
}

function requestMatches(
  candidate: { owner?: string; repo?: string; durationMinutes?: number } | null | undefined,
  request: ParsedReviewRequest,
): boolean {
  return Boolean(
    candidate &&
      candidate.owner?.toLowerCase() === request.owner.toLowerCase() &&
      candidate.repo?.toLowerCase() === request.repo.toLowerCase() &&
      Number(candidate.durationMinutes) === request.durationMinutes,
  );
}

function findRenderedReviewBlocks(request: ParsedReviewRequest): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('.function-block')).filter(block => {
    const text = block.textContent || '';
    return (
      text.includes(REVIEW_REQUEST_TOOL) &&
      text.toLowerCase().includes(request.owner.toLowerCase()) &&
      text.toLowerCase().includes(request.repo.toLowerCase())
    );
  });
}

function setRenderedReviewState(
  request: ParsedReviewRequest,
  state: 'pending' | 'approved',
): void {
  const blocks = findRenderedReviewBlocks(request);

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
      status.textContent = `در انتظار تأیید شما برای ${request.owner}/${request.repo}`;
      status.style.background = 'rgba(245, 158, 11, 0.14)';
      status.style.border = '1px solid rgba(245, 158, 11, 0.45)';
      status.style.color = 'inherit';
    } else {
      status.textContent = `✓ دسترسی ${request.owner}/${request.repo} تأیید و فعال شد`;
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
        message: target || entry.reason || 'درخواست Code Review توسط شما رد شد.',
        variant: 'warning',
      });
      break;

    case 'tool_denied':
    case 'response_denied':
      emitSecurityToast({
        id: `security-denied:${entry.timestamp || Date.now()}:${entry.toolName || entry.action}`,
        title: 'درخواست امنیتی مسدود شد',
        message: [entry.toolName, entry.resource, entry.reason].filter(Boolean).join(' — ') || 'Gate این عملیات را مسدود کرد.',
        variant: 'error',
        durationMs: 6500,
      });
      break;

    case 'notification_failed':
      emitSecurityToast({
        id: `notification-failed:${entry.timestamp || Date.now()}`,
        title: 'ارسال اعلان سیستم ناموفق بود',
        message: entry.reason || 'وضعیت امنیتی داخل MCP همچنان معتبر است.',
        variant: 'warning',
      });
      break;

    default:
      break;
  }
}

/**
 * Keeps MCP instructions generated and synchronized without rendering the old
 * sidebar Instructions UI. It recognizes the safe local approval tool directly
 * from raw ChatGPT output, creates a globally visible pending request bound to
 * its originating chat, and owns the global security toaster.
 *
 * Important: this does NOT grant GitHub access. GitHub read tools remain
 * unavailable until the user explicitly approves a specific queued request.
 */
export function HeadlessInstructionSync() {
  const { tools } = useAvailableTools();
  const { preferences } = useUserPreferences();
  const { isInitialized, isConnected, refreshTools } = useMcpCommunication();
  const refreshedForConnection = useRef(false);
  const processedSources = useRef<WeakSet<HTMLElement>>(new WeakSet());
  const inFlightKeys = useRef<Set<string>>(new Set());
  const knownRequests = useRef<Map<string, ParsedReviewRequest>>(new Map());
  const seenAuditEntries = useRef<Set<string>>(new Set());
  const auditSeeded = useRef(false);

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

    const processSource = async (source: HTMLElement) => {
      if (processedSources.current.has(source)) return;
      if (source.getAttribute('data-review-request-dispatched') === 'true') return;
      if (source.closest('.function-block')) return;

      const request = parseReviewRequest(source.textContent || '');
      if (!request) return;

      const path = currentConversationPath();
      const requestKey = `${path}:${request.owner.toLowerCase()}/${request.repo.toLowerCase()}:${request.durationMinutes}`;
      knownRequests.current.set(requestKey, request);
      if (inFlightKeys.current.has(requestKey)) return;

      processedSources.current.add(source);
      inFlightKeys.current.add(requestKey);

      try {
        logger.debug(
          `[HeadlessInstructionSync] Queueing approval request for ${request.owner}/${request.repo} (${request.durationMinutes}m) from ${path}`,
        );
        await dispatchReviewRequest(request);
        source.setAttribute('data-review-request-dispatched', 'true');

        emitSecurityToast({
          id: `access-request:${requestKey}`,
          title: 'تأیید Code Review لازم است',
          message: `${request.owner}/${request.repo} — ${request.durationMinutes} دقیقه، فقط‌خواندنی`,
          variant: 'warning',
        });

        setRenderedReviewState(request, 'pending');
        window.setTimeout(() => setRenderedReviewState(request, 'pending'), 100);
        window.setTimeout(() => setRenderedReviewState(request, 'pending'), 500);
      } catch (error) {
        processedSources.current.delete(source);
        const message = error instanceof Error ? error.message : String(error);
        logger.warn('[HeadlessInstructionSync] Local approval request dispatch failed:', message);
        emitSecurityToast({
          id: `access-request-error:${requestKey}`,
          title: 'ثبت درخواست دسترسی ناموفق بود',
          message,
          variant: 'error',
          durationMs: 6500,
        });
      } finally {
        inFlightKeys.current.delete(requestKey);
      }
    };

    const scan = () => {
      if (disposed) return;
      document.querySelectorAll<HTMLElement>('pre').forEach(source => {
        void processSource(source);
      });
    };

    const syncApprovalState = async () => {
      if (disposed) return;

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

        for (const request of knownRequests.current.values()) {
          if (requestMatches(response.session, request)) {
            setRenderedReviewState(request, 'approved');
          } else if (pendingRequests.some(candidate => requestMatches(candidate, request))) {
            setRenderedReviewState(request, 'pending');
          }
        }
      } catch (error) {
        logger.debug(
          '[HeadlessInstructionSync] Approval-state sync skipped:',
          error instanceof Error ? error.message : String(error),
        );
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
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    const approvalPoll = window.setInterval(() => void syncApprovalState(), 500);
    const auditPoll = window.setInterval(() => void syncSecurityToasts(), 1000);

    return () => {
      disposed = true;
      observer.disconnect();
      window.clearInterval(approvalPoll);
      window.clearInterval(auditPoll);
    };
  }, [isConnected, isInitialized]);

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
    logger.debug(
      `[HeadlessInstructionSync] Synced instructions for ${instructionTools.length} exposed MCP tool(s)`,
    );
  }, [generatedInstructions, instructionTools.length]);

  return <SecurityToastContainer />;
}
