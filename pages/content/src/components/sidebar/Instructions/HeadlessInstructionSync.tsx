import { useEffect, useMemo, useRef } from 'react';
import { useAvailableTools, useUserPreferences } from '../../../hooks';
import { useMcpCommunication } from '../../../hooks/useMcpCommunication';
import { createLogger } from '@extension/shared/lib/logger';
import { generateInstructionsJson } from './instructionGeneratorJson';
import { instructionsState } from './InstructionManager';

const logger = createLogger('HeadlessInstructionSync');
const REVIEW_REQUEST_TOOL = 'request_code_review_access';
const ALLOWED_DURATIONS = new Set([5, 10, 20]);

function readRenderedParameter(block: HTMLElement, name: string): unknown {
  const valueElement = block.querySelector<HTMLElement>(`.param-value[data-param-name="${name}"]`);
  if (!valueElement) return undefined;

  const rawAttribute = valueElement.getAttribute('data-param-value');
  if (rawAttribute) {
    try {
      return JSON.parse(rawAttribute);
    } catch {
      // Fall through to the plain-text representation.
    }
  }

  const currentValue = valueElement.getAttribute('data-current-value');
  if (currentValue !== null) return currentValue;
  return valueElement.textContent?.trim() || undefined;
}

/**
 * Keeps MCP instructions generated and synchronized without rendering the old
 * sidebar Instructions UI. It also handles the one safe local control tool
 * (request_code_review_access) automatically: asking for approval must not
 * depend on the generic Auto Execute toggle because this call does not read
 * GitHub or grant access; it only creates a pending local approval request.
 */
export function HeadlessInstructionSync() {
  const { tools } = useAvailableTools();
  const { preferences } = useUserPreferences();
  const { isInitialized, isConnected, refreshTools } = useMcpCommunication();
  const refreshedForConnection = useRef(false);
  const processedRequestBlocks = useRef<WeakSet<HTMLElement>>(new WeakSet());

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

  // The generic renderer's Auto Execute path is optional and historically
  // unreliable for this security-control call. Observe completed rendered
  // request blocks and dispatch the local request directly through McpClient.
  // This still traverses background -> executeGatedToolCall, so GitHub remains
  // inaccessible until the user explicitly approves the pending request.
  useEffect(() => {
    if (!isInitialized || !isConnected) return;

    let disposed = false;

    const tryDispatchRequest = async (block: HTMLElement) => {
      if (processedRequestBlocks.current.has(block)) return;

      const functionName = block.querySelector<HTMLElement>('.function-name-text')?.textContent?.trim();
      if (functionName !== REVIEW_REQUEST_TOOL) return;

      const ownerValue = readRenderedParameter(block, 'owner');
      const repoValue = readRenderedParameter(block, 'repo');
      const durationValue = readRenderedParameter(block, 'durationMinutes');

      const owner = typeof ownerValue === 'string' ? ownerValue.trim() : '';
      const repo = typeof repoValue === 'string' ? repoValue.trim() : '';
      if (!owner || !repo) return;

      const parsedDuration = Number(durationValue);
      const durationMinutes = ALLOWED_DURATIONS.has(parsedDuration) ? parsedDuration : 5;
      const mcpClient = (window as any).mcpClient;
      if (!mcpClient?.isReady?.()) return;

      processedRequestBlocks.current.add(block);

      try {
        logger.debug(
          `[HeadlessInstructionSync] Dispatching AI approval request for ${owner}/${repo} (${durationMinutes}m)`,
        );

        await mcpClient.callTool(REVIEW_REQUEST_TOOL, {
          owner,
          repo,
          durationMinutes,
        });

        if (!disposed) {
          block.setAttribute('data-review-request-dispatched', 'true');
        }
      } catch (error) {
        processedRequestBlocks.current.delete(block);
        logger.warn(
          '[HeadlessInstructionSync] AI approval request dispatch failed:',
          error instanceof Error ? error.message : String(error),
        );
      }
    };

    const scan = () => {
      document.querySelectorAll<HTMLElement>('.function-block').forEach(block => {
        void tryDispatchRequest(block);
      });
    };

    scan();
    const observer = new MutationObserver(scan);
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-current-value', 'data-param-value'],
    });

    return () => {
      disposed = true;
      observer.disconnect();
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
