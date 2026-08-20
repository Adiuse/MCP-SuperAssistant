export const DEFAULT_WEBSOCKET_URI = 'http://127.0.0.1:38106/mcp';
export const DEFAULT_SSE_URI = 'http://127.0.0.1:38106/mcp';
export const DEFAULT_STREAMABLE_HTTP_URI = 'http://127.0.0.1:38106/mcp';

export const CONNECTION_DEFAULTS = {
  websocket: {
    uri: DEFAULT_WEBSOCKET_URI,
    protocols: ['mcp-v1'],
    pingInterval: 30000,
    pongTimeout: 5000,
    maxReconnectAttempts: 3,
    binaryType: 'arraybuffer' as const,
  },
  sse: {
    uri: DEFAULT_SSE_URI,
    keepAlive: true,
    connectionTimeout: 5000,
    readTimeout: 30000,
  },
  'streamable-http': {
    uri: DEFAULT_STREAMABLE_HTTP_URI,
    keepAlive: true,
    connectionTimeout: 5000,
    readTimeout: 30000,
    fallbackToSSE: false,
    maxRetries: 2,
  },
};

export const GLOBAL_DEFAULTS = {
  timeout: 30000,
  maxRetries: 3,
  healthCheckInterval: 60000,
  reconnectDelay: 2000,
  logLevel: 'info' as const,
};

export function getDefaultUri(type: 'websocket' | 'sse' | 'streamable-http'): string {
  void type;
  return DEFAULT_STREAMABLE_HTTP_URI;
}
