import type { AuthorizedCodeReviewToolCall, CodeReviewSession } from './codeReviewGate.js';

export const SECURE_CODE_REVIEW_GATEWAY_URL = 'http://127.0.0.1:38106/mcp';
export const SECURE_CODE_REVIEW_TRANSPORT = 'streamable-http';
export const CODE_REVIEW_SERVER_ID = 'github-review';
export const CAPABILITY_ARGUMENT = '__mcp_superassistant_capability';

const DEVICE_SECRET_STORAGE_KEY = 'mcpCodeReviewGatewayDeviceSecret';
const PENDING_REVOCATIONS_STORAGE_KEY = 'mcpCodeReviewGatewayPendingRevocations';
const DEVICE_HEADER = 'X-MCP-SuperAssistant-Device';
const CONTROL_HEADER = 'X-MCP-SuperAssistant-Extension-Control';
const CONTROL_PREFIX = '/__mcp_superassistant/code-review';
const CONTROL_TIMEOUT_MS = 4_000;

function randomSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
}

export function isCanonicalCodeReviewGateway(uri: string, connectionType?: string): boolean {
  if (connectionType && connectionType !== SECURE_CODE_REVIEW_TRANSPORT) return false;
  try {
    return new URL(uri).toString() === SECURE_CODE_REVIEW_GATEWAY_URL;
  } catch {
    return false;
  }
}

export async function getOrCreateCodeReviewGatewayDeviceSecret(): Promise<string> {
  const stored = await chrome.storage.local.get(DEVICE_SECRET_STORAGE_KEY);
  const existing =
    typeof stored[DEVICE_SECRET_STORAGE_KEY] === 'string' ? stored[DEVICE_SECRET_STORAGE_KEY].trim() : '';
  if (/^[a-f0-9]{64}$/i.test(existing)) return existing;
  const created = randomSecret();
  await chrome.storage.local.set({ [DEVICE_SECRET_STORAGE_KEY]: created });
  return created;
}

export async function getCodeReviewGatewayTransportHeaders(): Promise<Record<string, string>> {
  return { [DEVICE_HEADER]: await getOrCreateCodeReviewGatewayDeviceSecret() };
}

async function controlRequest(path: 'lease' | 'revoke', payload: Record<string, unknown>): Promise<void> {
  const server = new URL(SECURE_CODE_REVIEW_GATEWAY_URL);
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
    const body = (await response.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
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

async function readPendingRevocations(): Promise<string[]> {
  const stored = await chrome.storage.local.get(PENDING_REVOCATIONS_STORAGE_KEY);
  const raw = stored[PENDING_REVOCATIONS_STORAGE_KEY];
  return Array.isArray(raw)
    ? [
        ...new Set(
          raw
            .filter((value): value is string => typeof value === 'string' && !!value.trim())
            .map(value => value.trim()),
        ),
      ]
    : [];
}

async function writePendingRevocations(sessionIds: string[]): Promise<void> {
  if (sessionIds.length === 0) {
    await chrome.storage.local.remove(PENDING_REVOCATIONS_STORAGE_KEY);
    return;
  }
  await chrome.storage.local.set({ [PENDING_REVOCATIONS_STORAGE_KEY]: [...new Set(sessionIds)].slice(-500) });
}

async function enqueueRevocation(sessionId: string): Promise<void> {
  await writePendingRevocations([...(await readPendingRevocations()), sessionId]);
}

async function removePendingRevocation(sessionId: string): Promise<void> {
  await writePendingRevocations((await readPendingRevocations()).filter(value => value !== sessionId));
}

export async function ensureCodeReviewGatewaySynchronized(): Promise<void> {
  const pending = await readPendingRevocations();
  for (const sessionId of pending) {
    await controlRequest('revoke', { sessionId });
    await removePendingRevocation(sessionId);
  }
}

export async function activateCodeReviewGatewayLease(session: CodeReviewSession): Promise<void> {
  await ensureCodeReviewGatewaySynchronized();
  await controlRequest('lease', {
    sessionId: session.id,
    capabilityId: session.capabilityId,
    capabilityToken: session.capabilityToken,
    jobId: session.jobId,
    userTurnId: session.userTurnId,
    owner: session.owner,
    repo: session.repo,
    originTabId: session.approvedTabId,
    sourcePath: session.sourcePath,
    expiresAt: session.expiresAt,
    readOnly: true,
    serverId: CODE_REVIEW_SERVER_ID,
    allowedTools: session.allowedTools,
  });
}

export async function revokeCodeReviewGatewayLease(sessionId: string): Promise<void> {
  if (!sessionId) return;
  await enqueueRevocation(sessionId);
  await controlRequest('revoke', { sessionId });
  await removePendingRevocation(sessionId);
}

export function attachCodeReviewCapability(
  args: Record<string, unknown>,
  authorization: AuthorizedCodeReviewToolCall,
): Record<string, unknown> {
  return {
    ...args,
    [CAPABILITY_ARGUMENT]: {
      sessionId: authorization.sessionId,
      capabilityId: authorization.capabilityId,
      capabilityToken: authorization.capabilityToken,
      jobId: authorization.jobId,
      userTurnId: authorization.userTurnId,
      originTabId: authorization.originTabId,
      sourcePath: authorization.sourcePath,
      serverId: CODE_REVIEW_SERVER_ID,
    },
  };
}

export const codeReviewGatewayCapabilityTestUtils = {
  DEVICE_HEADER,
  CONTROL_HEADER,
  CONTROL_PREFIX,
  PENDING_REVOCATIONS_STORAGE_KEY,
};
