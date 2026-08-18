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

registerCodeReviewControlBridge();

const logger = createLogger('mcp_client');

export { McpClient, PluginRegistry, EventEmitter };
export { SSEPlugin, WebSocketPlugin, WebSocketTransport };
export { DEFAULT_CLIENT_CONFIG };

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

let globalClient: McpClient | null = null;

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

function setupGlobalClientEventListeners(client: McpClient): void {
  client.on('connection:status-changed', event => {
    logger.debug('[Global Client] Connection status changed:', event);

    if (typeof window !== 'undefined' && window.dispatchEvent) {
      window.dispatchEvent(new CustomEvent('mcp:connection-status-changed', { detail: event }));
    }

    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
      chrome.runtime.sendMessage({
        type: 'mcp:connection-status-changed',
        payload: event,
        origin: 'mcpclient',
      }).catch(() => {});
    }
  });

  client.on('client:connected', event => logger.debug('[Global Client] Client connected:', event));
  client.on('client:disconnected', event => logger.debug('[Global Client] Client disconnected:', event));
  client.on('client:error', event => logger.error('[Global Client] Client error:', event));
}

export async function createMcpClient(config?: Partial<import('./types/config.js').ClientConfig>): Promise<McpClient> {
  const client = new McpClient(config);
  await client.initialize();
  return client;
}

function detectTransportType(uri: string): import('./types/plugin.js').TransportType {
  try {
    const url = new URL(uri);
    if (url.protocol === 'ws:' || url.protocol === 'wss:') return 'websocket';
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
  callerTabId?: number,
): Promise<any> {
  if (toolName === CODE_REVIEW_REQUEST_TOOL_NAME) {
    const existingPending = await getPendingCodeReviewRequest();
    const request = await createPendingCodeReviewRequest({
      sourceTabId: callerTabId,
      sourceKey: callerTabId === undefined ? undefined : `tab:${callerTabId}`,
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
        tabId: callerTabId,
        reason: 'AI requested Code Review approval',
      });
    }

    return {
      content: [
        {
          type: 'text',
          text: `Access request created for ${request.owner}/${request.repo} (${request.durationMinutes} minutes, read-only). Wait for explicit user approval before attempting GitHub read tools.`,
        },
      ],
      pendingApproval: true,
      requestId: request.id,
      owner: request.owner,
      repo: request.repo,
      durationMinutes: request.durationMinutes,
    };
  }

  const sanitizedArgs = await authorizeCodeReviewToolCall(toolName, args || {}, callerTabId);
  const result = await client.callTool(toolName, sanitizedArgs, adapterName);
  return await enforceCodeReviewResultPolicy(toolName, result);
}

async function getGatedPrimitives(client: McpClient, forceRefresh: boolean): Promise<any[]> {
  const session = await getActiveCodeReviewSession();

  if (!session) {
    return [{ type: 'tool', value: await getCodeReviewRequestTool() }];
  }

  const response = await client.getPrimitives(forceRefresh);
  const tools = await filterCodeReviewTools(response.tools);

  const primitives: any[] = [];
  tools.forEach(tool => primitives.push({ type: 'tool', value: tool }));
  return primitives;
}

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
  transportType?: import('./types/plugin.js').TransportType,
  callerTabId?: number,
): Promise<any> {
  const client = await getGlobalClient();
  const type = transportType || detectTransportType(uri);

  if (!client.isConnected()) await client.connect({ uri, type });
  return await executeGatedToolCall(client, toolName, args, adapterName, callerTabId);
}

export async function getPrimitivesWithBackwardsCompatibility(
  uri: string,
  forceRefresh: boolean = false,
  transportType?: import('./types/plugin.js').TransportType
): Promise<any[]> {
  const client = await getGlobalClient();
  const type = transportType || detectTransportType(uri);

  if (!client.isConnected()) await client.connect({ uri, type });
  return await getGatedPrimitives(client, forceRefresh);
}

export async function forceReconnectToMcpServer(
  uri: string,
  transportType?: import('./types/plugin.js').TransportType,
): Promise<void> {
  const client = await getGlobalClient();
  const type = transportType || detectTransportType(uri);

  if (client.isConnected()) await client.disconnect();
  await client.connect({ uri, type });
}

export async function runWithBackwardsCompatibility(
  uri: string,
  transportType?: import('./types/plugin.js').TransportType,
): Promise<void> {
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

export const callToolWithSSE = callToolWithBackwardsCompatibility;
export const getPrimitivesWithSSE = getPrimitivesWithBackwardsCompatibility;
export const runWithSSE = runWithBackwardsCompatibility;

export async function connectWithWebSocket(
  uri: string,
  config?: Partial<import('./types/config.js').ClientConfig>,
): Promise<McpClient> {
  const client = new McpClient(config);
  await client.initialize();
  await client.connect({ uri, type: 'websocket' });
  return client;
}

export async function callToolWithWebSocket(
  uri: string,
  toolName: string,
  args: { [key: string]: unknown },
  callerTabId?: number,
): Promise<any> {
  const client = await getGlobalClient();
  await client.connect({ uri, type: 'websocket' });
  return await executeGatedToolCall(client, toolName, args, undefined, callerTabId);
}

export async function getPrimitivesWithWebSocket(
  uri: string,
  forceRefresh: boolean = false
): Promise<any[]> {
  const client = await getGlobalClient();
  await client.connect({ uri, type: 'websocket' });
  return await getGatedPrimitives(client, forceRefresh);
}

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
