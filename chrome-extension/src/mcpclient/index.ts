// Core exports
import { McpClient } from './core/McpClient.js';
import { PluginRegistry } from './core/PluginRegistry.js';
import { EventEmitter } from './core/EventEmitter.js';

// Plugin implementations
import { SSEPlugin } from './plugins/sse/SSEPlugin.js';
import { WebSocketPlugin } from './plugins/websocket/WebSocketPlugin.js';
import { WebSocketTransport } from './plugins/websocket/WebSocketTransport.js';

// Configuration
import { DEFAULT_CLIENT_CONFIG } from './types/config.js';
import { createLogger } from '@extension/shared/lib/logger';
import {
  CODE_REVIEW_REQUEST_TOOL_NAME,
  authorizeCodeReviewToolCall,
  createPendingCodeReviewRequest,
  enforceCodeReviewResultPolicy,
  filterCodeReviewTools,
  getActiveCodeReviewSession,
  getCodeReviewRequestTool,
  getPendingCodeReviewRequest,
  recordCodeReviewAuditEvent,
} from '../security/codeReviewGate.js';
import { notifyCodeReviewAccessRequested } from '../security/codeReviewNotifications.js';
import { registerCodeReviewControlBridge } from '../security/codeReviewControlBridge.js';

// Register the explicit-approval control API as soon as the MCP client module is
// loaded by the background service worker.
registerCodeReviewControlBridge();

// Export core classes
const logger = createLogger('mcp_client');

export { McpClient, PluginRegistry, EventEmitter };

// Export plugins
export { SSEPlugin, WebSocketPlugin, WebSocketTransport };

// Export configuration
export { DEFAULT_CLIENT_CONFIG };

// Re-export types
export type {
  ITransportPlugin,
  PluginMetadata,
  PluginConfig,
  TransportType
} from './types/plugin.js';

export type {
  ClientConfig,
  ConnectionRequest,
  SSEPluginConfig,
  WebSocketPluginConfig,
  GlobalConfig
} from './types/config.js';

export type {
  Primitive,
  NormalizedTool,
  PrimitivesResponse,
  ToolCallRequest,
  ToolCallResult
} from './types/primitives.js';

export type { AllEvents } from './types/events.js';

// Singleton client instance for backward compatibility
let globalClient: McpClient | null = null;

/**
 * Get or create the global MCP client instance
 */
async function getGlobalClient(): Promise<McpClient> {
  if (!globalClient) {
    try {
      globalClient = new McpClient();
      await globalClient.initialize();
      setupGlobalClientEventListeners(globalClient);
    } catch (error) {
      logger.error('[getGlobalClient] Failed to initialize client:', error);
      globalClient = new McpClient();
      setupGlobalClientEventListeners(globalClient);
    }
  }
  return globalClient;
}

/**
 * Set up event listeners on the global client to handle connection events
 */
function setupGlobalClientEventListeners(client: McpClient): void {
  client.on('connection:status-changed', (event) => {
    logger.debug('[Global Client] Connection status changed:', event);

    if (typeof window !== 'undefined' && window.dispatchEvent) {
      window.dispatchEvent(new CustomEvent('mcp:connection-status-changed', {
        detail: event
      }));
    }

    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
      chrome.runtime.sendMessage({
        type: 'mcp:connection-status-changed',
        payload: event,
        origin: 'mcpclient'
      }).catch(() => {
        // Ignore errors if background script isn't listening
      });
    }
  });

  client.on('client:connected', (event) => {
    logger.debug('[Global Client] Client connected:', event);
  });

  client.on('client:disconnected', (event) => {
    logger.debug('[Global Client] Client disconnected:', event);
  });

  client.on('client:error', (event) => {
    logger.error('[Global Client] Client error:', event);
  });
}

/**
 * Create a new MCP client instance
 */
export async function createMcpClient(config?: Partial<import('./types/config.js').ClientConfig>): Promise<McpClient> {
  const client = new McpClient(config);
  await client.initialize();
  return client;
}

/**
 * Auto-detect transport type from URI
 */
function detectTransportType(uri: string): import('./types/plugin.js').TransportType {
  try {
    const url = new URL(uri);
    if (url.protocol === 'ws:' || url.protocol === 'wss:') {
      return 'websocket';
    }
    return 'sse';
  } catch {
    return 'sse';
  }
}

async function executeGatedToolCall(
  client: McpClient,
  toolName: string,
  args: { [key: string]: unknown },
  adapterName?: string,
): Promise<any> {
  // This is a local control tool. It never reaches GitHub and is intentionally
  // available while Code Review access is OFF so the AI can ask the user for
  // explicit approval using the same MCP tool-call flow documented by the project.
  if (toolName === CODE_REVIEW_REQUEST_TOOL_NAME) {
    const existingPending = await getPendingCodeReviewRequest();
    const request = await createPendingCodeReviewRequest({
      owner: args?.owner,
      repo: args?.repo,
      durationMinutes: args?.durationMinutes,
    });

    if (!existingPending) {
      const sent = await notifyCodeReviewAccessRequested(
        request.owner,
        request.repo,
        request.durationMinutes,
      );
      await recordCodeReviewAuditEvent({
        timestamp: Date.now(),
        action: sent ? 'notification_sent' : 'notification_failed',
        owner: request.owner,
        repo: request.repo,
        reason: 'AI requested Code Review approval',
      });
    }

    return {
      content: [
        {
          type: 'text',
          text: `Access request created for ${request.owner}/${request.repo} (${request.durationMinutes} minutes, read-only). Wait for the user to approve or reject it in the local Security Center before attempting GitHub read tools.`,
        },
      ],
      pendingApproval: true,
      requestId: request.id,
      owner: request.owner,
      repo: request.repo,
      durationMinutes: request.durationMinutes,
    };
  }

  const sanitizedArgs = await authorizeCodeReviewToolCall(toolName, args || {});
  const result = await client.callTool(toolName, sanitizedArgs, adapterName);
  return await enforceCodeReviewResultPolicy(toolName, result);
}

async function getGatedPrimitives(client: McpClient, forceRefresh: boolean): Promise<any[]> {
  const session = await getActiveCodeReviewSession();

  // Access is OFF by default. While OFF, expose only the local approval-request
  // tool. Do not even enumerate the GitHub MCP server's repository tools.
  if (!session) {
    return [{ type: 'tool', value: getCodeReviewRequestTool() }];
  }

  const response = await client.getPrimitives(forceRefresh);
  const tools = await filterCodeReviewTools(response.tools);

  const primitives: any[] = [];
  tools.forEach(tool => {
    primitives.push({ type: 'tool', value: tool });
  });
  return primitives;
}

// =============================================================================
// BACKWARD COMPATIBILITY API
// =============================================================================

export function isMcpServerConnected(): boolean {
  if (!globalClient) return false;
  return globalClient.isConnected();
}

export async function checkMcpServerConnection(): Promise<boolean> {
  try {
    const client = await getGlobalClient();
    return await client.isHealthy();
  } catch (error) {
    logger.error('[Backward Compatibility] checkMcpServerConnection failed:', error);
    return false;
  }
}

export async function callToolWithBackwardsCompatibility(
  uri: string,
  toolName: string,
  args: { [key: string]: unknown },
  adapterName?: string,
  transportType?: import('./types/plugin.js').TransportType
): Promise<any> {
  const client = await getGlobalClient();
  const type = transportType || detectTransportType(uri);

  if (!client.isConnected()) {
    await client.connect({ uri, type });
  }

  return await executeGatedToolCall(client, toolName, args, adapterName);
}

export async function getPrimitivesWithBackwardsCompatibility(
  uri: string,
  forceRefresh: boolean = false,
  transportType?: import('./types/plugin.js').TransportType
): Promise<any[]> {
  const client = await getGlobalClient();
  const type = transportType || detectTransportType(uri);

  if (!client.isConnected()) {
    await client.connect({ uri, type });
  }

  return await getGatedPrimitives(client, forceRefresh);
}

export async function forceReconnectToMcpServer(uri: string, transportType?: import('./types/plugin.js').TransportType): Promise<void> {
  const client = await getGlobalClient();
  const type = transportType || detectTransportType(uri);

  if (client.isConnected()) {
    await client.disconnect();
  }

  await client.connect({ uri, type });
}

export async function runWithBackwardsCompatibility(uri: string, transportType?: import('./types/plugin.js').TransportType): Promise<void> {
  const client = await getGlobalClient();
  const type = transportType || detectTransportType(uri);

  await client.connect({ uri, type });

  const primitives = await getGatedPrimitives(client, false);
  const toolCount = primitives.filter(p => p.type === 'tool').length;
  logger.debug(`Connected, ${toolCount} Code Review tools currently exposed`);
}

export function resetMcpConnectionState(): void {
  if (globalClient && globalClient.isConnected()) {
    globalClient.disconnect().catch(error => {
      logger.error('[Backward Compatibility] resetMcpConnectionState failed:', error);
    });
  }
}

export function resetMcpConnectionStateForRecovery(): void {
  logger.debug('[Backward Compatibility] resetMcpConnectionStateForRecovery - handled by plugin health monitoring');
}

export function abortMcpConnection(): void {
  if (globalClient) {
    globalClient.disconnect().catch(error => {
      logger.error('[Backward Compatibility] abortMcpConnection failed:', error);
    });
  }
}

// Legacy aliases
export const callToolWithSSE = callToolWithBackwardsCompatibility;
export const getPrimitivesWithSSE = getPrimitivesWithBackwardsCompatibility;
export const runWithSSE = runWithBackwardsCompatibility;

// WebSocket-specific functions
export async function connectWithWebSocket(uri: string, config?: Partial<import('./types/config.js').ClientConfig>): Promise<McpClient> {
  const client = new McpClient(config);
  await client.initialize();
  await client.connect({ uri, type: 'websocket' });
  return client;
}

export async function callToolWithWebSocket(
  uri: string,
  toolName: string,
  args: { [key: string]: unknown }
): Promise<any> {
  const client = await getGlobalClient();
  await client.connect({ uri, type: 'websocket' });
  return await executeGatedToolCall(client, toolName, args);
}

export async function getPrimitivesWithWebSocket(
  uri: string,
  forceRefresh: boolean = false
): Promise<any[]> {
  const client = await getGlobalClient();
  await client.connect({ uri, type: 'websocket' });
  return await getGatedPrimitives(client, forceRefresh);
}

// Utility function for normalizing tools
export function normalizeToolsFromPrimitives(primitives: any[]): any[] {
  return primitives
    .filter(p => p.type === 'tool')
    .map(p => {
      const tool = p.value;
      return {
        name: tool.name,
        description: tool.description || '',
        input_schema: tool.inputSchema || tool.input_schema || {},
        schema: tool.inputSchema ? JSON.stringify(tool.inputSchema) :
                tool.input_schema ? JSON.stringify(tool.input_schema) : '{}',
        ...(tool.uri && { uri: tool.uri }),
        ...(tool.arguments && { arguments: tool.arguments })
      };
    });
}
