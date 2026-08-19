import type { CodeReviewSession } from './codeReviewGate.js';

const DEVICE_SECRET_STORAGE_KEY = 'mcpCodeReviewGatewayDeviceSecret';
const DEVICE_HEADER = 'X-MCP-SuperAssistant-Device';
const CONTROL_HEADER = 'X-MCP-SuperAssistant-Extension-Control';
const CONTROL_PREFIX = '/__mcp_superassistant/code-review';
const CONTROL_TIMEOUT_MS = 4_000;

function randomSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
}

function isSafeGatewayUrl(url: URL): boolean {
  if (url.protocol === 'https:') return true;
  if (url.protocol !== 'http:') return false;
  const host = url.hostname.toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
}

async function configuredServerUrl(): Promise<URL> {
  const stored = await chrome.storage.local.get(['mcpServerUrl', 'mcpConnectionType']);
  const raw = typeof stored.mcpServerUrl === 'string' ? stored.mcpServerUrl.trim() : '';
  const connectionType = typeof stored.mcpConnectionType === 'string' ? stored.mcpConnectionType : '';
  if (connectionType && connectionType !== 'streamable-http') {
    throw new Error('Secure Code Review capability gateway requires Streamable HTTP transport.');
  }
  if (!raw) throw new Error('MCP server URL is not configured.');
  const url = new URL(raw);
  if (!isSafeGatewayUrl(url)) {
    throw new Error('Code Review gateway must use HTTPS or a loopback HTTP endpoint.');
  }
  return url;
}

export async function getOrCreateCodeReviewGatewayDeviceSecret(): Promise<string> {
  const stored = await chrome.storage.local.get(DEVICE_SECRET_STORAGE_KEY);
  const existing = typeof stored[DEVICE_SECRET_STORAGE_KEY] === 'string'
    ? stored[DEVICE_SECRET_STORAGE_KEY].trim()
    : '';
  if (/^[a-f0-9]{64}$/i.test(existing)) return existing;
  const created = randomSecret();
  await chrome.storage.local.set({ [DEVICE_SECRET_STORAGE_KEY]: created });
  return created;
}

export async function getCodeReviewGatewayTransportHeaders(): Promise<Record<string, string>> {
  return { [DEVICE_HEADER]: await getOrCreateCodeReviewGatewayDeviceSecret() };
}

async function controlRequest(path: 'lease' | 'revoke', payload: Record<string, unknown>): Promise<void> {
  const server = await configuredServerUrl();
  const endpoint = new URL(`${CONTROL_PREFIX}/${path}`, server.origin);
  const deviceSecret = await getOrCreateCodeReviewGatewayDeviceSecret();
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), CONTROL_TIMEOUT_MS);

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      cache: 'no-store',
      credentials: 'omit',
      signal: abortController.signal,
      headers: {
        'Content-Type': 'application/json',
        [DEVICE_HEADER]: deviceSecret,
        [CONTROL_HEADER]: '1',
      },
      body: JSON.stringify(payload),
    });
    const body = await response.json().catch(() => null) as { ok?: boolean; error?: string } | null;
    if (!response.ok || body?.ok !== true) {
      throw new Error(body?.error || `Capability gateway returned HTTP ${response.status}`);
    }
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error('Secure Code Review capability gateway timed out.');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function activateCodeReviewGatewayLease(session: CodeReviewSession): Promise<void> {
  await controlRequest('lease', {
    sessionId: session.id,
    capabilityId: session.capabilityId,
    jobId: session.jobId,
    userTurnId: session.userTurnId,
    owner: session.owner,
    repo: session.repo,
    originTabId: session.approvedTabId,
    sourcePath: session.sourcePath,
    expiresAt: session.expiresAt,
    readOnly: true,
    allowedTools: session.allowedTools,
  });
}

export async function revokeCodeReviewGatewayLease(sessionId: string): Promise<void> {
  if (!sessionId) return;
  await controlRequest('revoke', { sessionId });
}

export const codeReviewGatewayCapabilityTestUtils = {
  DEVICE_HEADER,
  CONTROL_HEADER,
  CONTROL_PREFIX,
  isSafeGatewayUrl,
};
