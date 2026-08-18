import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import { eventBus } from '../events';
import { getToolEnablementState, saveToolEnablementState } from '../utils/storage';
import type { Tool, DetectedTool, ToolExecution } from '../types/stores';
import { createLogger } from '@extension/shared/lib/logger';

const logger = createLogger('useToolStore');

export interface ToolState {
  availableTools: Tool[];
  detectedTools: DetectedTool[];
  toolExecutions: Record<string, ToolExecution>;
  isExecuting: boolean;
  lastExecutionId: string | null;
  enabledTools: Set<string>;
  isLoadingEnablement: boolean;
  setAvailableTools: (tools: Tool[]) => void;
  addDetectedTool: (tool: DetectedTool) => void;
  clearDetectedTools: () => void;
  startToolExecution: (toolName: string, parameters: Record<string, any>) => string;
  updateToolExecution: (execution: Partial<ToolExecution> & { id: string }) => void;
  completeToolExecution: (id: string, result: any, status: 'success' | 'error', error?: string) => void;
  getToolExecution: (id: string) => ToolExecution | undefined;
  enableTool: (toolName: string) => void;
  disableTool: (toolName: string) => void;
  enableAllTools: () => void;
  disableAllTools: () => void;
  isToolEnabled: (toolName: string) => boolean;
  loadToolEnablementState: () => Promise<void>;
}

const initialState: Omit<ToolState, 'setAvailableTools' | 'addDetectedTool' | 'clearDetectedTools' | 'startToolExecution' | 'updateToolExecution' | 'completeToolExecution' | 'getToolExecution' | 'enableTool' | 'disableTool' | 'enableAllTools' | 'disableAllTools' | 'isToolEnabled' | 'loadToolEnablementState'> = {
  availableTools: [],
  detectedTools: [],
  toolExecutions: {},
  isExecuting: false,
  lastExecutionId: null,
  enabledTools: new Set(),
  isLoadingEnablement: false,
};

export const useToolStore = create<ToolState>()(
  devtools(
    (set, get) => ({
      ...initialState,

      setAvailableTools: (tools: Tool[]) => {
        set({ availableTools: tools });
        logger.debug('[ToolStore] Available tools updated:', tools);
        eventBus.emit('tool:list-updated', { tools });
        void get().loadToolEnablementState();
      },

      addDetectedTool: (tool: DetectedTool) => {
        set(state => ({ detectedTools: [...state.detectedTools, tool] }));
        logger.debug('[ToolStore] Tool detected:', tool);
        eventBus.emit('tool:detected', { tools: [tool], source: tool.source || 'unknown' });
      },

      clearDetectedTools: () => {
        set({ detectedTools: [] });
        logger.debug('[ToolStore] Detected tools cleared.');
      },

      startToolExecution: (toolName: string, parameters: Record<string, any>): string => {
        const executionId = `exec_${toolName}_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
        const newExecution: ToolExecution = {
          id: executionId,
          toolName,
          parameters,
          status: 'pending',
          timestamp: Date.now(),
          result: null,
        };
        set(state => ({
          toolExecutions: { ...state.toolExecutions, [executionId]: newExecution },
          isExecuting: true,
          lastExecutionId: executionId,
        }));
        logger.debug(`Starting execution for ${toolName} (ID: ${executionId})`, parameters);
        eventBus.emit('tool:execution-started', { toolName, callId: executionId });
        return executionId;
      },

      updateToolExecution: (executionUpdate: Partial<ToolExecution> & { id: string }) => {
        const { id, ...updateData } = executionUpdate;
        const existingExecution = get().toolExecutions[id];
        if (!existingExecution) {
          logger.warn(`Attempted to update non-existent execution (ID: ${id})`);
          return;
        }

        const updatedExecution = { ...existingExecution, ...updateData, timestamp: Date.now() };
        set(state => ({
          toolExecutions: { ...state.toolExecutions, [id]: updatedExecution },
          isExecuting: updatedExecution.status === 'pending',
        }));
        logger.debug(`Execution updated (ID: ${id}):`, updatedExecution);
        if (updatedExecution.status === 'success' || updatedExecution.status === 'error') {
          eventBus.emit('tool:execution-completed', { execution: updatedExecution });
        }
      },

      completeToolExecution: (id: string, result: any, status: 'success' | 'error', error?: string) => {
        const execution = get().toolExecutions[id];
        if (!execution) {
          logger.warn(`Attempted to complete non-existent execution (ID: ${id})`);
          return;
        }

        const completedExecution: ToolExecution = {
          ...execution,
          result,
          status,
          error,
          timestamp: Date.now(),
        };
        set(state => ({
          toolExecutions: { ...state.toolExecutions, [id]: completedExecution },
          isExecuting: Object.values(state.toolExecutions).some(ex => ex.id !== id && ex.status === 'pending'),
        }));
        logger.debug(`Execution ${status} (ID: ${id}):`, completedExecution);
        eventBus.emit('tool:execution-completed', { execution: completedExecution });
        if (status === 'error') {
          eventBus.emit('tool:execution-failed', {
            toolName: execution.toolName,
            error: error || 'Unknown execution error',
            callId: id,
          });
        }
      },

      getToolExecution: (id: string): ToolExecution | undefined => get().toolExecutions[id],

      enableTool: (toolName: string) => {
        set(state => {
          const newEnabledTools = new Set([...state.enabledTools, toolName]);
          saveToolEnablementState(newEnabledTools).catch(error =>
            logger.error('[ToolStore] Failed to save tool enablement state:', error),
          );
          return { enabledTools: newEnabledTools };
        });
        logger.debug(`Tool enabled: ${toolName}`);
      },

      disableTool: (toolName: string) => {
        set(state => {
          const newEnabledTools = new Set(state.enabledTools);
          newEnabledTools.delete(toolName);
          saveToolEnablementState(newEnabledTools).catch(error =>
            logger.error('[ToolStore] Failed to save tool enablement state:', error),
          );
          return { enabledTools: newEnabledTools };
        });
        logger.debug(`Tool disabled: ${toolName}`);
      },

      enableAllTools: () => {
        set(state => {
          const newEnabledTools = new Set(state.availableTools.map(tool => tool.name));
          saveToolEnablementState(newEnabledTools).catch(error =>
            logger.error('[ToolStore] Failed to save tool enablement state:', error),
          );
          return { enabledTools: newEnabledTools };
        });
        logger.debug('[ToolStore] All tools enabled');
      },

      disableAllTools: () => {
        const newEnabledTools = new Set<string>();
        set({ enabledTools: newEnabledTools });
        saveToolEnablementState(newEnabledTools).catch(error =>
          logger.error('[ToolStore] Failed to save tool enablement state:', error),
        );
        logger.debug('[ToolStore] All tools disabled');
      },

      isToolEnabled: (toolName: string): boolean => get().enabledTools.has(toolName),

      loadToolEnablementState: async () => {
        set({ isLoadingEnablement: true });
        try {
          const storedEnabledTools = await getToolEnablementState();
          const state = get();
          const availableNames = new Set(state.availableTools.map(tool => tool.name));
          const overlappingEnabled = [...storedEnabledTools].filter(name => availableNames.has(name));

          // Code Review intentionally swaps the exposed tool set:
          // OFF => request_code_review_access only
          // ON  => read-only GitHub allowlist
          // If the stored enabled set has zero overlap with the newly exposed set,
          // carrying it forward would make every new tool appear disabled and the
          // generated model instructions would incorrectly say that no MCP tools exist.
          if (
            state.availableTools.length > 0 &&
            (storedEnabledTools.size === 0 || overlappingEnabled.length === 0)
          ) {
            const allCurrentToolsEnabled = new Set(state.availableTools.map(tool => tool.name));
            set({ enabledTools: allCurrentToolsEnabled, isLoadingEnablement: false });
            await saveToolEnablementState(allCurrentToolsEnabled);
            logger.debug('[ToolStore] Exposed tool set changed; enabled the current gated tools');
            return;
          }

          set({ enabledTools: storedEnabledTools, isLoadingEnablement: false });
          logger.debug(`Tool enablement state loaded: ${storedEnabledTools.size} tools enabled`);
        } catch (error) {
          logger.error('[ToolStore] Failed to load tool enablement state:', error);
          set({ isLoadingEnablement: false });
        }
      },
    }),
    { name: 'ToolStore', store: 'tool' },
  ),
);
