#!/usr/bin/env node
import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = Number(process.env.MCP_GATEWAY_PORT || 38106);
const DEFAULT_UPSTREAM = process.env.MCP_UPSTREAM_URL || 'http://127.0.0.1:38107/mcp';
const DEVICE_HEADER = 'x-mcp-superassistant-device';
const CONTROL_HEADER = 'x-mcp-superassistant-extension-control';
const CONTROL_PREFIX = '/__mcp_superassistant/code-review';
export const CAPABILITY_ARGUMENT = '__mcp_superassistant_capability';
export const CODE_REVIEW_SERVER_ID = 'github-review';
export const MAX_TOOL_CALLS = 200;
export const MAX_SINGLE_RESPONSE_BYTES = 2 * 1024 * 1024;
export const MAX_LEASE_RESPONSE_BYTES = 25 * 1024 * 1024;
const MAX_CONTROL_BODY_BYTES = 256 * 1024;
const MAX_MCP_BODY_BYTES = 4 * 1024 * 1024;

export const ALLOWED_TOOLS = new Set([
  'get_me',
  'get_file_contents',
  'get_repository_tree',
  'search_code',
  'list_commits',
  'get_commit',
  'get_file_blame',
  'list_branches',
  'list_tags',
  'get_tag',
  'list_pull_requests',
  'pull_request_read',
]);

const REPO_SCOPED_TOOLS = new Set([
  'get_file_contents',
  'get_repository_tree',
  'list_commits',
  'get_commit',
  'get_file_blame',
  'list_branches',
  'list_tags',
  'get_tag',
  'list_pull_requests',
  'pull_request_read',
]);

const LEASE_FREE_MCP_METHODS = new Set([
  'initialize',
  'ping',
  'tools/list',
  'notifications/initialized',
  'notifications/cancelled',
]);

function cleanString(value, max = 500) {
  return typeof value === 'string'
    ? value
        .replace(/[\u0000-\u001f\u007f]/g, '')
        .trim()
        .slice(0, max)
    : '';
}

function validSecret(value) {
  return /^[a-f0-9]{64}$/i.test(cleanString(value, 100));
}

function safeSecretEqual(left, right) {
  if (!validSecret(left) || !validSecret(right)) return false;
  return timingSafeEqual(Buffer.from(left.toLowerCase()), Buffer.from(right.toLowerCase()));
}

function cleanSourcePath(value) {
  const clean = cleanString(value, 500);
  if (!clean.startsWith('/') || clean.includes('?') || clean.includes('#')) return '';
  return clean;
}

function isLoopbackAddress(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function isLoopbackUpstream(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && url.pathname === '/mcp' && ['127.0.0.1', '::1', '[::1]'].includes(url.hostname);
  } catch {
    return false;
  }
}

export function canonicalToolName(rawName) {
  const name = cleanString(rawName, 180);
  if (ALLOWED_TOOLS.has(name)) return name;
  const escaped = CODE_REVIEW_SERVER_ID.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = name.match(new RegExp(`^${escaped}(?:__|[.:/])(.+)$`, 'i'));
  return match && ALLOWED_TOOLS.has(match[1]) ? match[1] : name;
}

function cleanLease(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('lease payload is required');
  const sessionId = cleanString(raw.sessionId, 200);
  const capabilityId = cleanString(raw.capabilityId, 200);
  const capabilityToken = cleanString(raw.capabilityToken, 100);
  const jobId = cleanString(raw.jobId, 200);
  const userTurnId = cleanString(raw.userTurnId, 200);
  const owner = cleanString(raw.owner, 100);
  const repo = cleanString(raw.repo, 120);
  const sourcePath = cleanSourcePath(raw.sourcePath);
  const originTabId = Number(raw.originTabId);
  const expiresAt = Number(raw.expiresAt);
  const readOnly = raw.readOnly === true;
  const serverId = cleanString(raw.serverId, 100);
  const allowedTools = Array.isArray(raw.allowedTools)
    ? raw.allowedTools.map(value => cleanString(value, 100)).filter(Boolean)
    : [];

  if (!sessionId || !capabilityId || !jobId || !userTurnId || !owner || !repo || !sourcePath) {
    throw new Error('lease is missing prompt-bound identity fields');
  }
  if (!validSecret(capabilityToken)) throw new Error('lease capability token is invalid');
  if (serverId !== CODE_REVIEW_SERVER_ID) throw new Error('lease MCP server provenance is invalid');
  if (!Number.isInteger(originTabId) || originTabId < 0) throw new Error('lease originTabId is invalid');
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw new Error('lease is already expired');
  if (!readOnly) throw new Error('only read-only leases are accepted');
  if (allowedTools.length === 0 || allowedTools.some(tool => !ALLOWED_TOOLS.has(tool))) {
    throw new Error('lease contains a tool outside the read-only allowlist');
  }

  return {
    sessionId,
    capabilityId,
    capabilityToken,
    jobId,
    userTurnId,
    owner,
    repo,
    sourcePath,
    originTabId,
    expiresAt,
    readOnly: true,
    serverId,
    allowedTools: [...new Set(allowedTools)],
    callCount: 0,
    responseBytes: 0,
  };
}

export function createGatewayState() {
  return { devices: new Map() };
}

function deviceFor(state, deviceSecret) {
  return validSecret(deviceSecret) ? state.devices.get(deviceSecret.toLowerCase()) : undefined;
}

function pruneDevice(state, deviceSecret, now = Date.now()) {
  const key = cleanString(deviceSecret, 100).toLowerCase();
  const device = state.devices.get(key);
  if (!device) return undefined;
  for (const [sessionId, lease] of device.leases) {
    if (lease.expiresAt <= now) device.leases.delete(sessionId);
  }
  device.lastSeen = now;
  if (device.leases.size === 0 && now - device.lastSeen > 24 * 60 * 60_000) state.devices.delete(key);
  return device;
}

export function registerLease(state, deviceSecret, rawLease) {
  if (!validSecret(deviceSecret)) throw new Error('device credential is invalid');
  const lease = cleanLease(rawLease);
  const key = deviceSecret.toLowerCase();
  const existing = state.devices.get(key) || { leases: new Map(), lastSeen: Date.now() };
  const previous = existing.leases.get(lease.sessionId);
  if (previous) {
    lease.callCount = previous.callCount;
    lease.responseBytes = previous.responseBytes;
  }
  existing.leases.set(lease.sessionId, lease);
  existing.lastSeen = Date.now();
  state.devices.set(key, existing);
  return lease;
}

export function revokeLease(state, deviceSecret, sessionId) {
  const device = deviceFor(state, deviceSecret);
  if (!device) return false;
  const removed = device.leases.delete(cleanString(sessionId, 200));
  device.lastSeen = Date.now();
  return removed;
}

function exactRepoMatch(lease, args) {
  return (
    cleanString(args?.owner, 100).toLowerCase() === lease.owner.toLowerCase() &&
    cleanString(args?.repo, 120).toLowerCase() === lease.repo.toLowerCase()
  );
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function searchRepoMatch(lease, args) {
  const query = cleanString(args?.query, 20_000);
  if (!query || /\b(?:org|user|owner):/i.test(query) || /\b(?:OR|NOT)\b/.test(query)) return false;
  const repoQualifiers = [...query.matchAll(/\brepo:([^\s]+)/gi)].map(match => match[1].toLowerCase());
  if (repoQualifiers.length !== 1 || repoQualifiers[0] !== `${lease.owner}/${lease.repo}`.toLowerCase()) return false;
  const expectedSuffix = new RegExp(`\\srepo:${escapeRegExp(lease.owner)}/${escapeRegExp(lease.repo)}\\s*$`, 'i');
  return expectedSuffix.test(query);
}

function capabilityEnvelope(args) {
  const raw = args?.[CAPABILITY_ARGUMENT];
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
}

function bindingMatches(lease, envelope) {
  return (
    cleanString(envelope.sessionId, 200) === lease.sessionId &&
    cleanString(envelope.capabilityId, 200) === lease.capabilityId &&
    safeSecretEqual(cleanString(envelope.capabilityToken, 100), lease.capabilityToken) &&
    cleanString(envelope.jobId, 200) === lease.jobId &&
    cleanString(envelope.userTurnId, 200) === lease.userTurnId &&
    Number(envelope.originTabId) === lease.originTabId &&
    cleanSourcePath(envelope.sourcePath) === lease.sourcePath &&
    cleanString(envelope.serverId, 100) === lease.serverId
  );
}

export function authorizeToolCall(state, deviceSecret, request, now = Date.now()) {
  if (!validSecret(deviceSecret))
    return { ok: false, status: 401, reason: 'missing or invalid extension device credential' };
  const device = pruneDevice(state, deviceSecret, now);
  if (!device || device.leases.size === 0) {
    return { ok: false, status: 403, reason: 'no active extension-approved Code Review lease' };
  }

  const params = request?.params || {};
  const rawToolName = params.name;
  const toolName = canonicalToolName(rawToolName);
  if (!ALLOWED_TOOLS.has(toolName)) {
    return {
      ok: false,
      status: 403,
      reason: `tool '${cleanString(rawToolName, 180)}' is not from the immutable GitHub read-only server allowlist`,
    };
  }

  const args =
    params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
      ? params.arguments
      : {};
  const envelope = capabilityEnvelope(args);
  if (!envelope) return { ok: false, status: 403, reason: 'prompt-bound per-call capability is missing' };
  const sessionId = cleanString(envelope.sessionId, 200);
  const lease = device.leases.get(sessionId);
  if (!lease || !bindingMatches(lease, envelope)) {
    return {
      ok: false,
      status: 403,
      reason: 'capability does not match the exact session/job/user-turn/origin binding',
    };
  }
  if (!lease.allowedTools.includes(toolName)) {
    return { ok: false, status: 403, reason: 'tool is outside this lease allowlist' };
  }
  if (lease.callCount >= MAX_TOOL_CALLS) {
    device.leases.delete(lease.sessionId);
    return { ok: false, status: 429, reason: 'lease tool-call ceiling reached and capability was revoked' };
  }

  const scopeMatches =
    toolName === 'get_me' ||
    (toolName === 'search_code'
      ? searchRepoMatch(lease, args)
      : REPO_SCOPED_TOOLS.has(toolName) && exactRepoMatch(lease, args));
  if (!scopeMatches) {
    return { ok: false, status: 403, reason: 'tool call does not match the exact approved repository/search scope' };
  }

  lease.callCount += 1;
  const forwardedArgs = { ...args };
  delete forwardedArgs[CAPABILITY_ARGUMENT];
  return {
    ok: true,
    lease,
    request: { ...request, params: { ...params, arguments: forwardedArgs } },
  };
}

function isExtensionControlRequest(req) {
  const origin = cleanString(req.headers.origin, 300).toLowerCase();
  if (req.headers[CONTROL_HEADER] !== '1') return false;
  return origin.startsWith('chrome-extension://') || origin.startsWith('moz-extension://') || !origin;
}

function extensionOrigin(req) {
  const origin = cleanString(req.headers.origin, 300);
  return origin.startsWith('chrome-extension://') || origin.startsWith('moz-extension://') ? origin : '';
}

function setCors(req, res, control = false) {
  const origin = extensionOrigin(req);
  if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', control ? 'POST, OPTIONS' : 'POST, GET, DELETE, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    control
      ? 'content-type, x-mcp-superassistant-device, x-mcp-superassistant-extension-control'
      : 'content-type, accept, mcp-protocol-version, mcp-session-id, x-mcp-superassistant-device',
  );
  res.setHeader('Access-Control-Max-Age', '600');
}

async function readBody(req, maxBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) throw new Error('request body is too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readResponseBody(response, maxBytes) {
  if (!response.body) return Buffer.alloc(0);
  const chunks = [];
  let total = 0;
  for await (const chunk of Readable.fromWeb(response.body)) {
    total += chunk.length;
    if (total > maxBytes) {
      await response.body.cancel().catch(() => {});
      return null;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function safeForwardHeaders(headers) {
  const forwarded = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const lower = name.toLowerCase();
    if ([DEVICE_HEADER, CONTROL_HEADER, 'host', 'content-length', 'connection', 'origin'].includes(lower)) continue;
    if (Array.isArray(value)) value.forEach(item => forwarded.append(name, item));
    else forwarded.set(name, value);
  }
  return forwarded;
}

function copyResponseHeaders(upstreamResponse, res, contentLength) {
  upstreamResponse.headers.forEach((value, name) => {
    if (
      ['transfer-encoding', 'connection', 'content-length', 'access-control-allow-origin'].includes(name.toLowerCase())
    )
      return;
    res.setHeader(name, value);
  });
  if (contentLength !== undefined) res.setHeader('Content-Length', contentLength);
  res.setHeader('Cache-Control', 'no-store');
}

function parseAndAuthorizeRpc(state, deviceSecret, body) {
  let rpc;
  try {
    rpc = JSON.parse(body.toString('utf8'));
  } catch {
    return { error: { status: 400, reason: 'invalid JSON-RPC body' } };
  }
  if (Array.isArray(rpc))
    return { error: { status: 403, reason: 'JSON-RPC batches are disabled at the capability boundary' } };
  const method = cleanString(rpc?.method, 120);
  if (!method) return { error: { status: 400, reason: 'JSON-RPC method is required' } };
  if (method === 'tools/call') {
    const authorization = authorizeToolCall(state, deviceSecret, rpc);
    if (!authorization.ok) return { error: { status: authorization.status, reason: authorization.reason } };
    return { rpc: authorization.request, lease: authorization.lease };
  }
  if (!LEASE_FREE_MCP_METHODS.has(method)) {
    return { error: { status: 403, reason: `MCP method '${method}' is not allowed by the Code Review gateway` } };
  }
  return { rpc };
}

async function proxyMcpRequest(req, res, state, upstreamUrl) {
  const deviceSecret = cleanString(req.headers[DEVICE_HEADER], 100);
  if (!validSecret(deviceSecret)) {
    return sendJson(res, 401, { error: 'valid extension device credential required' });
  }

  if (req.method === 'OPTIONS') {
    if (!extensionOrigin(req)) return sendJson(res, 403, { error: 'extension origin required' });
    res.statusCode = 204;
    return res.end();
  }
  if (!['POST', 'GET', 'DELETE'].includes(req.method || '')) {
    return sendJson(res, 405, { error: 'MCP method not allowed' });
  }

  let body = Buffer.alloc(0);
  let authorizedLease = null;
  if (req.method === 'POST') {
    body = await readBody(req, MAX_MCP_BODY_BYTES);
    if (body.length === 0) return sendJson(res, 400, { error: 'JSON-RPC body is required' });
    const checked = parseAndAuthorizeRpc(state, deviceSecret, body);
    if (checked.error) {
      return sendJson(res, checked.error.status, {
        error: 'Code Review capability denied',
        reason: checked.error.reason,
      });
    }
    body = Buffer.from(JSON.stringify(checked.rpc));
    authorizedLease = checked.lease || null;
  }

  const target = new URL('/mcp', upstreamUrl);
  const init = { method: req.method, headers: safeForwardHeaders(req.headers), redirect: 'manual' };
  if (body.length > 0) init.body = body;
  const upstreamResponse = await fetch(target, init);

  if (!authorizedLease) {
    res.statusCode = upstreamResponse.status;
    copyResponseHeaders(upstreamResponse, res);
    if (!upstreamResponse.body) return res.end();
    return Readable.fromWeb(upstreamResponse.body).pipe(res);
  }

  const responseBody = await readResponseBody(upstreamResponse, MAX_SINGLE_RESPONSE_BYTES);
  if (responseBody === null) {
    return sendJson(res, 413, { error: 'Code Review response denied', reason: 'single response exceeded 2 MB' });
  }
  const nextTotal = authorizedLease.responseBytes + responseBody.length;
  if (nextTotal > MAX_LEASE_RESPONSE_BYTES) {
    revokeLease(state, deviceSecret, authorizedLease.sessionId);
    return sendJson(res, 413, {
      error: 'Code Review response denied',
      reason: 'lease response ceiling reached; capability revoked',
    });
  }
  authorizedLease.responseBytes = nextTotal;
  res.statusCode = upstreamResponse.status;
  copyResponseHeaders(upstreamResponse, res, responseBody.length);
  res.end(responseBody);
}

export function createCapabilityGatewayServer({ state = createGatewayState(), upstreamUrl = DEFAULT_UPSTREAM } = {}) {
  if (!isLoopbackUpstream(upstreamUrl))
    throw new Error('capability gateway upstream must be an explicit loopback /mcp endpoint');
  return http.createServer(async (req, res) => {
    try {
      if (!isLoopbackAddress(req.socket.remoteAddress))
        return sendJson(res, 403, { ok: false, error: 'loopback clients only' });
      const requestUrl = new URL(req.url || '/', 'http://127.0.0.1');
      if (requestUrl.pathname.startsWith(CONTROL_PREFIX)) {
        setCors(req, res, true);
        if (req.method === 'OPTIONS') {
          if (!extensionOrigin(req)) return sendJson(res, 403, { ok: false, error: 'extension origin required' });
          res.statusCode = 204;
          return res.end();
        }
        if (req.method !== 'POST' || !isExtensionControlRequest(req)) {
          return sendJson(res, 403, { ok: false, error: 'extension control request required' });
        }
        const deviceSecret = cleanString(req.headers[DEVICE_HEADER], 100);
        if (!validSecret(deviceSecret)) return sendJson(res, 401, { ok: false, error: 'device credential is invalid' });
        const body = JSON.parse((await readBody(req, MAX_CONTROL_BODY_BYTES)).toString('utf8') || '{}');
        if (requestUrl.pathname === `${CONTROL_PREFIX}/lease`) {
          const lease = registerLease(state, deviceSecret, body);
          return sendJson(res, 200, { ok: true, sessionId: lease.sessionId, expiresAt: lease.expiresAt });
        }
        if (requestUrl.pathname === `${CONTROL_PREFIX}/revoke`) {
          revokeLease(state, deviceSecret, body.sessionId);
          return sendJson(res, 200, { ok: true });
        }
        return sendJson(res, 404, { ok: false, error: 'unknown control endpoint' });
      }

      if (requestUrl.pathname !== '/mcp') return sendJson(res, 404, { error: 'not found' });
      setCors(req, res, false);
      await proxyMcpRequest(req, res, state, upstreamUrl);
    } catch (error) {
      if (!res.headersSent) sendJson(res, 502, { error: error instanceof Error ? error.message : String(error) });
      else res.destroy(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

const isMain = process.argv[1] && new URL(import.meta.url).pathname === process.argv[1];
if (isMain) {
  if (process.env.MCP_GATEWAY_HOST && process.env.MCP_GATEWAY_HOST !== DEFAULT_HOST) {
    throw new Error('MCP_GATEWAY_HOST is security-fixed to 127.0.0.1');
  }
  const server = createCapabilityGatewayServer();
  server.listen(DEFAULT_PORT, DEFAULT_HOST, () => {
    console.log(`[code-review-gateway] listening on http://${DEFAULT_HOST}:${DEFAULT_PORT}/mcp`);
    console.log(`[code-review-gateway] upstream ${DEFAULT_UPSTREAM}`);
    console.log('[code-review-gateway] fail-closed: tools/call requires an exact per-call prompt/origin capability');
  });
}
