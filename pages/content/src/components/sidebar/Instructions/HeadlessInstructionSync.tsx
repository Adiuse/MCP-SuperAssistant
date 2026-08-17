import { useEffect, useMemo, useRef } from 'react';
import { useAvailableTools, useUserPreferences } from '../../../hooks';
import { useMcpCommunication } from '../../../hooks/useMcpCommunication';
import { createLogger } from '@extension/shared/lib/logger';
import { generateInstructionsJson } from './instructionGeneratorJson';
import { instructionsState } from './InstructionManager';

const logger = createLogger('HeadlessInstructionSync');

/**
 * Keeps MCP instructions generated and synchronized without rendering the old
 * sidebar Instructions UI. The Persian security sidebar remains the only
 * visible sidebar; MCPPopover continues to consume instructionsState exactly
 * as it did before the security redesign.
 */
export function HeadlessInstructionSync() {
  const { tools } = useAvailableTools();
  const { preferences } = useUserPreferences();
  const { isInitialized, isConnected, refreshTools } = useMcpCommunication();
  const refreshedForConnection = useRef(false);

  // The content-side McpClient already loads tools during startup. This one
  // guarded refresh closes races where the sidebar mounts before the initial
  // tool response reaches the Zustand store.
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
