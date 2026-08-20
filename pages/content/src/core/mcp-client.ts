import { contextBridge } from './context-bridge';
import { useConnectionStore } from '../stores/connection.store';
import { useToolStore } from '../stores/tool.store';
import { eventBus } from '../events/event-bus';
import type { ServerConfig, ConnectionStatus } from '../types/stores';
import { logMessage } from '../utils/helpers';
import { pluginRegistry } from '../plugins';

/**
 * McpClient – Enhanced wrapper around ContextBridge for communicating with the
 * background script and managing MCP (Model Context Protocol) connections.
 *
 * This class provides:
 * - Type-safe communication with the background script
 * - Automatic state synchronization with Zustand stores
 * - Connection heartbeat and health monitoring
 * - Tool execution and management
 * - Server configuration handling
 * - Comprehensive error handling and recovery
 *
 * The client follows a singleton pattern to ensure consistent state management
 * across the entire content script lifecycle.
 */
class McpClient {
  private static instance: McpClient | null = null;
  private isInitialized = false;
  private heartbeatInterval: number | null = null;
  private readonly HEARTBEAT_INTERVAL = 30000; // 30 seconds

  private constructor() {
    this.initialize();
  }

  private initialize(): void {
    if (this.isInitialized) {
      logMessage('[McpClient] Already initialized');
      return;
    }

    try {
      logMessage('[McpClient] Starting initialization...');
      contextBridge.initialize();
      logMessage('[McpClient] Context bridge initialized');
      this.setupMessageListeners();
      logMessage('[McpClient] Message listeners setup complete');
      this.startHeartbeat();
      logMessage('[McpClient] Heartbeat started');
      this.isInitialized = true;
      this.requestInitialState().catch(error => {
        logMessage(
          `[McpClient] Initial state request failed (non-blocking): ${error instanceof Error ? error.message : String(error)}`,
        );
      });
      logMessage('[McpClient] Initialized successfully');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logMessage(`[McpClient] Initialization failed: ${errorMessage}`);
      this.isInitialized = false;
      eventBus.emit('error:unhandled', {
        error: error instanceof Error ? error : new Error(errorMessage),
        context: 'mcp-client-initialization',
      });
      throw error;
    }
  }

  private async requestInitialState(): Promise<void> {
    const maxRetries = 3;
    let retryCount = 0;

    while (retryCount < maxRetries) {
      try {
        logMessage(`[McpClient] Requesting initial state from background (attempt ${retryCount + 1}/${maxRetries})...`);

        try {
          const statusResponse = await this.getCurrentConnectionStatus();
          if (statusResponse) {
            logMessage(
              `[McpClient] Initial connection status: ${statusResponse.status} (isConnected: ${statusResponse.isConnected})`,
            );
            const connectionStatus = statusResponse.status as ConnectionStatus;
            this.handleConnectionStatusChange(connectionStatus, undefined);
          }
        } catch (statusError) {
          logMessage(
            `[McpClient] Failed to get initial connection status: ${statusError instanceof Error ? statusError.message : String(statusError)}`,
          );
        }

        try {
          const config = await this.getServerConfig();
          useConnectionStore.getState().setServerConfig(config);
          logMessage(`[McpClient] Initial server config loaded: ${JSON.stringify(config)}`);
        } catch (configError) {
          logMessage(
            `[McpClient] Failed to get server config: ${configError instanceof Error ? configError.message : String(configError)}`,
          );
          useConnectionStore.getState().setServerConfig({
            uri: 'http://127.0.0.1:38106/mcp',
            connectionType: 'streamable-http',
            timeout: 5000,
            retryAttempts: 3,
            retryDelay: 2000,
          });
        }

        try {
          const tools = await this.getAvailableTools(true);
          logMessage(`[McpClient] Initial tools loaded: ${tools.length} tools`);
        } catch (toolsError) {
          logMessage(
            `[McpClient] Failed to get initial tools: ${toolsError instanceof Error ? toolsError.message : String(toolsError)}`,
          );
        }

        logMessage('[McpClient] Initial state request completed successfully');
        return;
      } catch (error) {
        retryCount++;
        const errorMessage = error instanceof Error ? error.message : String(error);
        logMessage(`[McpClient] Initial state request attempt ${retryCount} failed: ${errorMessage}`);

        if (retryCount >= maxRetries) {
          logMessage(
            `[McpClient] All ${maxRetries} initial state request attempts failed. Continuing with degraded functionality.`,
          );
          eventBus.emit('error:unhandled', {
            error: error instanceof Error ? error : new Error(errorMessage),
            context: 'mcp-client-initial-state',
          });
          return;
        }

        const delay = Math.min(1000 * Math.pow(2, retryCount - 1), 5000);
        logMessage(`[McpClient] Retrying in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  private setupMessageListeners(): void {
    contextBridge.onMessage('connection:status-changed', message => {
      try {
        const { status, error, isConnected } = message.payload ?? {};
        logMessage(`[McpClient] Received connection status message: ${JSON.stringify(message)}`);
        if (status) {
          logMessage(`[McpClient] Processing status: ${status}, error: ${error}, isConnected: ${isConnected}`);
          this.handleConnectionStatusChange(status, error);
        } else {
          logMessage(
            `[McpClient] Warning: No status in connection message payload. Received: ${JSON.stringify(message)}`,
          );
        }
      } catch (error) {
        logMessage(
          `[McpClient] Error processing connection status message: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    });

    contextBridge.onMessage('mcp:tool-update', message => {
      try {
        const tools = Array.isArray(message.payload)
          ? message.payload
          : Array.isArray(message.payload?.tools)
            ? message.payload.tools
            : [];
        logMessage(`[McpClient] Received tool update: ${tools.length} tools`);
        this.handleToolUpdate(tools);
      } catch (error) {
        logMessage(
          `[McpClient] Error processing tool update: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    });

    contextBridge.onMessage('mcp:server-config-updated', message => {
      try {
        const { config } = message.payload ?? {};
        if (config) {
          logMessage(`[McpClient] Received server config update: ${JSON.stringify(config)}`);
          this.handleServerConfigUpdate(config);
        } else {
          logMessage(`[McpClient] Warning: No config in server config update message`);
        }
      } catch (error) {
        logMessage(
          `[McpClient] Error processing server config update: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    });

    contextBridge.onMessage('mcp:heartbeat-response', message => {
      try {
        const { timestamp, isConnected } = message.payload ?? {};
        if (timestamp) {
          if (typeof isConnected === 'boolean') {
            const currentStatus = useConnectionStore.getState().status;
            const expectedStatus = isConnected ? 'connected' : 'disconnected';
            if (currentStatus !== expectedStatus) {
              logMessage(
                `[McpClient] Heartbeat indicates status should be ${expectedStatus}, updating from ${currentStatus}`,
              );
              this.handleConnectionStatusChange(expectedStatus);
            }
          }
          this.handleHeartbeatResponse(timestamp);
        } else {
          logMessage(`[McpClient] Warning: No timestamp in heartbeat response`);
        }
      } catch (error) {
        logMessage(
          `[McpClient] Error processing heartbeat response: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    });

    logMessage('[McpClient] Message listeners configured successfully');
  }

  private handleConnectionStatusChange(status: ConnectionStatus, error?: string): void {
    const store = useConnectionStore.getState();
    logMessage(`[McpClient] Connection status changed to: ${status}${error ? ` (${error})` : ''}`);

    switch (status) {
      case 'connected':
        store.setConnected(Date.now());
        eventBus.emit('connection:status-changed', { status, error: undefined });
        logMessage(`[McpClient] Emitted connected status to event bus`);
        this.getAvailableTools(true)
          .then(tools => {
            logMessage(`[McpClient] Auto-fetched ${tools.length} tools after connection`);
          })
          .catch(error => {
            logMessage(
              `[McpClient] Failed to auto-fetch tools after connection: ${error instanceof Error ? error.message : String(error)}`,
            );
          });
        break;
      case 'reconnecting':
        store.startReconnecting();
        eventBus.emit('connection:status-changed', { status, error: undefined });
        logMessage(`[McpClient] Emitted reconnecting status to event bus`);
        break;
      case 'error':
        store.setDisconnected(error ?? 'Unknown connection error');
        eventBus.emit('connection:status-changed', { status, error: error ?? 'Unknown connection error' });
        logMessage(`[McpClient] Emitted error status to event bus`);
        break;
      case 'disconnected':
      default:
        store.setDisconnected(error);
        eventBus.emit('connection:status-changed', { status: 'disconnected', error });
        logMessage(`[McpClient] Emitted disconnected status to event bus`);
    }
  }

  private handleToolUpdate(tools: any[]): void {
    logMessage(`[McpClient] Received tool update with ${tools.length} tools`);
    const normalizedTools = tools.map(tool => ({
      name: tool.name,
      description: tool.description || '',
      input_schema: tool.input_schema || tool.schema || {},
      schema: typeof tool.schema === 'string' ? tool.schema : JSON.stringify(tool.input_schema || {}),
    }));
    useToolStore.getState().setAvailableTools(normalizedTools);
    eventBus.emit('tool:list-updated', { tools: normalizedTools });
  }

  private handleServerConfigUpdate(config: Partial<ServerConfig>): void {
    logMessage('[McpClient] Server config updated from background');
    useConnectionStore.getState().setServerConfig(config);
  }

  private handleHeartbeatResponse(timestamp: number): void {
    eventBus.emit('connection:heartbeat', { timestamp });
  }

  private startHeartbeat(): void {
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
    this.heartbeatInterval = window.setInterval(() => {
      this.sendHeartbeat().catch(error => {
        logMessage(`[McpClient] Heartbeat failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }, this.HEARTBEAT_INTERVAL);
    logMessage('[McpClient] Heartbeat started');
  }

  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
      logMessage('[McpClient] Heartbeat stopped');
    }
  }

  private async sendHeartbeat(): Promise<void> {
    try {
      await contextBridge.sendMessage('background', 'mcp:heartbeat', { timestamp: Date.now() }, { timeout: 5000 });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logMessage(`[McpClient] Heartbeat failed: ${errorMessage}`);
    }
  }

  async callTool(toolName: string, args: Record<string, unknown>): Promise<any> {
    if (!this.isInitialized) throw new Error('McpClient not initialized');
    if (!toolName || typeof toolName !== 'string') throw new Error('Tool name is required and must be a string');

    const connectionStore = useConnectionStore.getState();
    if (connectionStore.status !== 'connected') {
      throw new Error(
        `Not connected to MCP server. Current status: ${connectionStore.status}. Please check your connection.`,
      );
    }

    logMessage(`[McpClient] Calling tool: ${toolName} with args: ${JSON.stringify(args)}`);
    const activePlugin = pluginRegistry.getActivePlugin();
    const adapterName = activePlugin?.name || window.location.hostname || 'unknown';
    const executionId = useToolStore.getState().startToolExecution(toolName, args);

    try {
      const result = await contextBridge.sendMessage(
        'background',
        'mcp:call-tool',
        { toolName, args, adapterName },
        { timeout: 30_000 },
      );

      logMessage(`[McpClient] Tool call successful: ${toolName}`);
      useToolStore.getState().completeToolExecution(executionId, result, 'success');
      eventBus.emit('tool:execution-completed', {
        execution: {
          id: executionId,
          toolName,
          parameters: args,
          result,
          timestamp: Date.now(),
          status: 'success' as const,
        },
      });
      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logMessage(`[McpClient] Tool call failed: ${toolName} - ${errorMessage}`);
      useToolStore.getState().completeToolExecution(executionId, null, 'error', errorMessage);
      eventBus.emit('tool:execution-failed', { toolName, error: errorMessage, callId: executionId });
      if (this.isConnectionError(errorMessage)) {
        logMessage(`[McpClient] Tool call failed due to connection issue, updating connection status`);
        connectionStore.setDisconnected(`Tool call failed: ${errorMessage}`);
      }
      throw error;
    }
  }

  private isConnectionError(errorMessage: string): boolean {
    const connectionErrorPatterns = [
      /connection refused/i,
      /econnrefused/i,
      /timeout/i,
      /etimedout/i,
      /network error/i,
      /server unavailable/i,
      /could not connect/i,
      /connection failed/i,
      /transport error/i,
      /fetch failed/i,
      /chrome runtime error/i,
    ];
    return connectionErrorPatterns.some(pattern => pattern.test(errorMessage));
  }

  async getAvailableTools(forceRefresh = false): Promise<any[]> {
    if (!this.isInitialized) throw new Error('McpClient not initialized');
    logMessage(`[McpClient] Getting available tools (forceRefresh: ${forceRefresh})`);

    try {
      const tools = await contextBridge.sendMessage(
        'background',
        'mcp:get-tools',
        { forceRefresh },
        { timeout: 10_000 },
      );

      const validatedTools = Array.isArray(tools) ? tools : [];
      const normalizedTools = validatedTools.map(tool => ({
        name: tool.name,
        description: tool.description || '',
        input_schema: tool.input_schema || tool.schema || {},
        schema: typeof tool.schema === 'string' ? tool.schema : JSON.stringify(tool.input_schema || {}),
      }));

      useToolStore.getState().setAvailableTools(normalizedTools);
      logMessage(`[McpClient] Retrieved ${normalizedTools.length} tools`);
      return normalizedTools;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logMessage(`[McpClient] Failed to get available tools: ${errorMessage}`);
      throw error;
    }
  }

  async forceReconnect(): Promise<boolean> {
    if (!this.isInitialized) throw new Error('McpClient not initialized');
    logMessage('[McpClient] Force reconnect requested');
    const connectionStore = useConnectionStore.getState();

    try {
      connectionStore.startReconnecting();
      eventBus.emit('connection:status-changed', { status: 'reconnecting', error: undefined });
      const response = await contextBridge.sendMessage('background', 'mcp:force-reconnect', {}, { timeout: 25_000 });

      const isConnected = response?.isConnected ?? false;
      if (isConnected) {
        connectionStore.setConnected(Date.now());
        logMessage('[McpClient] Force reconnect successful');
        eventBus.emit('connection:status-changed', { status: 'connected', error: undefined });
        try {
          await this.getAvailableTools(true);
          logMessage('[McpClient] Tools refreshed after successful reconnection');
        } catch (toolError) {
          logMessage(
            `[McpClient] Failed to refresh tools after reconnect: ${toolError instanceof Error ? toolError.message : String(toolError)}`,
          );
        }
      } else {
        const errorMsg = response?.error || 'Reconnect attempt failed';
        connectionStore.setDisconnected(errorMsg);
        logMessage(`[McpClient] Force reconnect failed: ${errorMsg}`);
        eventBus.emit('connection:status-changed', { status: 'disconnected', error: errorMsg });
      }
      return isConnected;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      connectionStore.setDisconnected(`Reconnect failed: ${errorMessage}`);
      logMessage(`[McpClient] Force reconnect error: ${errorMessage}`);
      eventBus.emit('connection:status-changed', { status: 'error', error: `Reconnect failed: ${errorMessage}` });
      throw error;
    }
  }

  async forceConnectionStatusCheck(): Promise<void> {
    if (!this.isInitialized) throw new Error('McpClient not initialized');
    logMessage('[McpClient] Forcing immediate connection status check');

    try {
      const statusResponse = await this.getCurrentConnectionStatus();
      if (statusResponse) {
        logMessage(
          `[McpClient] Immediate connection status: ${statusResponse.status} (isConnected: ${statusResponse.isConnected})`,
        );
        const connectionStatus = statusResponse.status as ConnectionStatus;
        this.handleConnectionStatusChange(connectionStatus, undefined);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logMessage(`[McpClient] Failed to get immediate connection status: ${errorMessage}`);
    }
  }

  async getServerConfig(): Promise<ServerConfig> {
    if (!this.isInitialized) throw new Error('McpClient not initialized');
    logMessage('[McpClient] Getting server config');

    try {
      const config = await contextBridge.sendMessage('background', 'mcp:get-server-config', {}, { timeout: 5_000 });
      logMessage('[McpClient] Server config retrieved successfully');
      return config;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logMessage(`[McpClient] Failed to get server config: ${errorMessage}`);
      throw error;
    }
  }

  async getCurrentConnectionStatus(): Promise<{ status: string; isConnected: boolean; timestamp: number }> {
    if (!this.isInitialized) throw new Error('McpClient not initialized');
    logMessage('[McpClient] Getting current connection status');

    try {
      const statusResponse = await contextBridge.sendMessage(
        'background',
        'mcp:get-connection-status',
        {},
        { timeout: 5_000 },
      );
      logMessage(`[McpClient] Current connection status retrieved: ${statusResponse.status}`);
      return statusResponse;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logMessage(`[McpClient] Failed to get current connection status: ${errorMessage}`);
      throw error;
    }
  }

  async updateServerConfig(config: Partial<ServerConfig>): Promise<boolean> {
    if (!this.isInitialized) throw new Error('McpClient not initialized');
    logMessage(`[McpClient] Updating server config: ${JSON.stringify(config)}`);

    try {
      const response = await contextBridge.sendMessage(
        'background',
        'mcp:update-server-config',
        { config },
        { timeout: 15_000 },
      );
      const success = !!response?.success;
      if (success) {
        useConnectionStore.getState().setServerConfig(config);
        logMessage('[McpClient] Server config updated successfully');
      } else {
        logMessage('[McpClient] Server config update failed');
      }
      return success;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logMessage(`[McpClient] Failed to update server config: ${errorMessage}`);
      throw error;
    }
  }

  getConnectionStatus(): ConnectionStatus {
    return useConnectionStore.getState().status;
  }

  isReady(): boolean {
    return this.isInitialized;
  }

  cleanup(): void {
    this.stopHeartbeat();
    this.isInitialized = false;
    logMessage('[McpClient] Cleanup completed');
  }

  public static getInstance(): McpClient {
    if (!McpClient.instance) McpClient.instance = new McpClient();
    return McpClient.instance;
  }

  public static resetInstance(): void {
    if (McpClient.instance) {
      McpClient.instance.cleanup();
      McpClient.instance = null;
    }
  }
}

export const mcpClient = McpClient.getInstance();
export type { McpClient };
