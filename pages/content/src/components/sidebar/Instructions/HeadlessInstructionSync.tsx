import { useEffect, useMemo, useRef } from 'react';
import { useAvailableTools, useUserPreferences } from '../../../hooks';
import { useMcpCommunication } from '../../../hooks/useMcpCommunication';
import { createLogger } from '@extension/shared/lib/logger';
import { generateInstructionsJson } from './instructionGeneratorJson';
import { instructionsState } from './InstructionManager';

const logger = createLogger('HeadlessInstructionSync');
const REVIEW_REQUEST_TOOL = 'request_code_review_access';
const ALLOWED_DURATIONS = new Set([5, 10, 20]);

interface ParsedReviewRequest {
  owner: string;
  repo: string;
  durationMinutes: 5 | 10 | 20;
}

interface ReviewStatusResponse {
  success?: boolean;
  session?: {
    owner?: string;
    repo?: string;
    durationMinutes?: number;
  } | null;
  pendingRequest?: {
    owner?: string;
    repo?: string;
    durationMinutes?: number;
  } | null;
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
  const response = await chrome.runtime.sendMessage({
    type: 'mcp:call-tool',
    origin: 'content',
    timestamp: Date.now(),
    expectResponse: true,
    payload: {
      toolName: REVIEW_REQUEST_TOOL,
      args: request,
      adapterName: 'security-approval',
    },
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

      // A second execution of the access-request tool would only create a new
      // pending request, so disable the generic Run/Re-execute controls after
      // approval. GitHub reads continue through the newly exposed read tools.
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

/**
 * Keeps MCP instructions generated and synchronized without rendering the old
 * sidebar Instructions UI. It also recognizes the single safe local approval
 * tool directly from the raw ChatGPT <pre> block.
 *
 * Important: this does NOT grant GitHub access. It only executes the synthetic
 * request_code_review_access tool, whose gated implementation creates a local
 * pending request. GitHub read tools remain unavailable until the user approves.
 */
export function HeadlessInstructionSync() {
  const { tools } = useAvailableTools();
  const { preferences } = useUserPreferences();
  const { isInitialized, isConnected, refreshTools } = useMcpCommunication();
  const refreshedForConnection = useRef(false);
  const processedSources = useRef<WeakSet<HTMLElement>>(new WeakSet());
  const inFlightKeys = useRef<Set<string>>(new Set());
  const knownRequests = useRef<Map<string, ParsedReviewRequest>>(new Map());

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
    if (!isConnected) {
      refreshedForConnection.current = false;
    }
  }, [isConnected]);

  useEffect(() => {
    if (!isInitialized || !isConnected) return;

    let disposed = false;
    let scanScheduled = false;

    const processSource = async (source: HTMLElement) => {
      if (processedSources.current.has(source)) return;
      if (source.closest('.function-block')) return;

      const request = parseReviewRequest(source.textContent || '');
      if (!request) return;

      const requestKey = `${request.owner.toLowerCase()}/${request.repo.toLowerCase()}:${request.durationMinutes}`;
      knownRequests.current.set(requestKey, request);
      if (inFlightKeys.current.has(requestKey)) return;

      processedSources.current.add(source);
      inFlightKeys.current.add(requestKey);

      try {
        logger.debug(
          `[HeadlessInstructionSync] Dispatching local approval request for ${request.owner}/${request.repo} (${request.durationMinutes}m)`,
        );
        await dispatchReviewRequest(request);
        source.setAttribute('data-review-request-dispatched', 'true');

        // Rendering of the generic function card can finish a few ticks after
        // the raw <pre> has been parsed, so update both immediately and shortly
        // afterwards.
        setRenderedReviewState(request, 'pending');
        window.setTimeout(() => setRenderedReviewState(request, 'pending'), 100);
        window.setTimeout(() => setRenderedReviewState(request, 'pending'), 500);
      } catch (error) {
        processedSources.current.delete(source);
        logger.warn(
          '[HeadlessInstructionSync] Local approval request dispatch failed:',
          error instanceof Error ? error.message : String(error),
        );
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
      if (disposed || knownRequests.current.size === 0) return;

      try {
        const response = (await chrome.runtime.sendMessage({
          type: 'code-review:get-status',
        })) as ReviewStatusResponse;

        if (!response?.success) return;

        for (const request of knownRequests.current.values()) {
          if (requestMatches(response.session, request)) {
            setRenderedReviewState(request, 'approved');
          } else if (requestMatches(response.pendingRequest, request)) {
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

    const observer = new MutationObserver(scheduleScan);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    const approvalPoll = window.setInterval(() => void syncApprovalState(), 500);

    return () => {
      disposed = true;
      observer.disconnect();
      window.clearInterval(approvalPoll);
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

  return null;
}
