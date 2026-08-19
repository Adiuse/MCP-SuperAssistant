#!/usr/bin/env node
import http from 'node:http';
import { Readable } from 'node:stream';

const DEFAULT_HOST = process.env.MCP_GATEWAY_HOST || 'localhost';
const DEFAULT_PORT = Number(process.env.MCP_GATEWAY_PORT || 38106);
const DEFAULT_UPSTREAM = process.env.MCP_UPSTREAM_URL || 'http://localhost:38107/mcp';
const DEVICE_HEADER = 'x-mcp-superassistant-device';
const CONTROL_HEADER = 'x-mcp-superassistant-extension-control';
const CONTROL_PREFIX = '/__mcp_superassistant/code-review';
const MAX_CONTROL_BODY_BYTES = 256 * 1024;

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

export function canonicalToolName(rawName) {
  const name = String(rawName || '').trim();
  if (!name) return '';
  const candidates = [name];
  for (const separator of ['.', '__', '/', ':']) {
    if (name.includes(separator)) candidates.push(name.split(separator).at(-1));
  }
  for (const candidate of candidates) {
    if (ALLOWED_TOOLS.has(candidate)) return candidate;
  }
  return name;
}

function isLoopbackAddress(address) {
  if (!address) return false;
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function validDeviceSecret(value) {
  return /^[a-f0-9]{64}$/i.test(String(value || '').trim());
}

function cleanString(value, max = 500) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max) : '';
}

function cleanLease(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('lease payload is required');
  const sessionId = cleanString(raw.sessionId, 200);
  const capabilityId = cleanString(raw.capabilityId, 200);
  const jobId = cleanString(raw.jobId, 200);
  const userTurnId = cleanString(raw.userTurnId, 200);
  const owner = cleanString(raw.owner, 100);
  const repo = cleanString(raw.repo, 120);
  const sourcePath = cleanString(raw.sourcePath, 500);
  const originTabId = Number(raw.originTabId);
  const expiresAt = Number(raw.expiresAt);
  const readOnly = raw.readOnly === true;
  const allowedTools = Array.isArray(raw.allowedTools)
    ? raw.allowedTools.map(value => cleanString(value, 100)).filter(Boolean)
    : [];

  if (!sessionId || !capabilityId || !jobId || !userTurnId || !owner || !repo || !sourcePath) {
    throw new Error('lease is missing prompt-bound identity fields');
  }
  if (!Number.isInteger(originTabId) || originTabId < 0) throw new Error('lease originTabId is invalid');
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw new Error('lease is already expired');
  if (!readOnly) throw new Error('only read-only leases are accepted');
  if (allowedTools.length === 0 || allowedTools.some(tool => !ALLOWED_TOOLS.has(tool))) {
    throw new Error('lease contains a tool outside the read-only allowlist');
  }

  return {
    sessionId,
    capabilityId,
    jobId,
    userTurnId,
    owner,
    repo,
    sourcePath,
    originTabId,
    expiresAt,
    readOnly: true,
    allowedTools: [...new Set(allowedTools)],
  };
}

export function createGatewayState() {
  return { devices: new Map() };
}

function leasesForDevice(state, deviceSecret, now = Date.now()) {
  const device = state.devices.get(deviceSecret);
  if (!device) return [];
  for (const [sessionId, lease] of device.leases) {
    if (lease.expiresAt <= now) device.leases.delete(sessionId);
  }
  if (device.leases.size === 0 && now - device.lastSeen > 24 * 60 * 60_000) {
    state.devices.delete(deviceSecret);
    return [];
  }
  device.lastSeen = now;
  return [...device.leases.values()];
}

export function registerLease(state, deviceSecret, rawLease) {
  if (!validDeviceSecret(deviceSecret)) throw new Error('device credential is invalid');
  const lease = cleanLease(rawLease);
  const existing = state.devices.get(deviceSecret) || { leases: new Map(), lastSeen: Date.now() };
  existing.leases.set(lease.sessionId, lease);
  existing.lastSeen = Date.now();
  state.devices.set(deviceSecret, existing);
  return lease;
}

export function revokeLease(state, deviceSecret, sessionId) {
  if (!validDeviceSecret(deviceSecret)) return false;
  const device = state.devices.get(deviceSecret);
  if (!device) return false;
  const removed = device.leases.delete(cleanString(sessionId, 200));
  device.lastSeen = Date.now();
  return removed;
}

function exactRepoMatch(lease, args) {
  const owner = cleanString(args?.owner, 100).toLowerCase();
  const repo = cleanString(args?.repo, 120).toLowerCase();
  return owner === lease.owner.toLowerCase() && repo === lease.repo.toLowerCase();
}

function searchRepoMatch(lease, args) {
  const query = cleanString(args?.query, 20_000);
  if (!query) return false;
  if (/\b(?:org|user|owner):/i.test(query)) return false;
  const repoQualifiers = [...query.matchAll(/\brepo:([^\s]+)/gi)].map(match => match[1].toLowerCase());
  if (repoQualifiers.length !== 1) return false;
  return repoQualifiers[0] === `${lease.owner}/${lease.repo}`.toLowerCase();
}

export function authorizeToolCall(state, deviceSecret, request, now = Date.now()) {
  if (!validDeviceSecret(deviceSecret)) return { ok: false, status: 401, reason: 'missing or invalid extension device credential' };
  const leases = leasesForDevice(state, deviceSecret, now);
  if (leases.length === 0) return { ok: false, status: 403, reason: 'no active extension-approved Code Review lease' };

  const params = request?.params || {};
  const rawToolName = params.name;
  const toolName = canonicalToolName(rawToolName);
  if (!ALLOWED_TOOLS.has(toolName)) {
    return { ok: false, status: 403, reason: `tool '${cleanString(rawToolName, 180)}' is not in the read-only allowlist` };
  }
  const args = params.arguments || {};

  const matchingLease = leases.find(lease => {
    if (!lease.allowedTools.includes(toolName)) return false;
    if (toolName === 'get_me') return true;
    if (toolName === 'search_code') return searchRepoMatch(lease, args);
    if (REPO_SCOPED_TOOLS.has(toolName)) return exactRepoMatch(lease, args);
    return false;
  });

  if (!matchingLease) {
    return { ok: false, status: 403, reason: 'tool call does not match any active prompt-bound repository lease' };
  }

  return {
    ok: true,
    lease: {
      sessionId: matchingLease.sessionId,
      jobId: matchingLease.jobId,
      userTurnId: matchingLease.userTurnId,
      capabilityId: matchingLease.capabilityId,
      owner: matchingLease.owner,
      repo: matchingLease.repo,
      expiresAt: matchingLease.expiresAt,
    },
  };
}

function isExtensionControlRequest(req) {
  const origin = cleanString(req.headers.origin, 300).toLowerCase();
  const explicitControl = req.headers[CONTROL_HEADER] === '1';
  if (!explicitControl) return false;
  if (origin.startsWith('chrome-extension://') || origin.startsWith('moz-extension://')) return true;
  // Chrome extension service-worker fetches may omit Origin. A normal webpage
  // using this custom header triggers a CORS preflight and cannot suppress its
  // browser-generated Origin. Native local malware is outside this threat model.
  return !origin;
}

function corsOrigin(req) {
  const origin = cleanString(req.headers.origin, 300);
  return origin.startsWith('chrome-extension://') || origin.startsWith('moz-extension://') ? origin : '';
}

function setControlCors(req, res) {
  const origin = corsOrigin(req);
  if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type, x-mcp-superassistant-device, x-mcp-superassistant-extension-control');
  res.setHeader('Access-Control-Max-Age', '600');
}

async function readBody(req, maxBytes = MAX_CONTROL_BODY_BYTES) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) throw new Error('request body is too large');
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
    if (lower === DEVICE_HEADER || lower === CONTROL_HEADER || lower === 'host' || lower === 'content-length' || lower === 'connection') continue;
    if (Array.isArray(value)) value.forEach(item => forwarded.append(name, item));
    else forwarded.set(name, value);
  }
  return forwarded;
}

function copyResponseHeaders(upstreamResponse, res) {
  upstreamResponse.headers.forEach((value, name) => {
    if (name.toLowerCase() === 'transfer-encoding' || name.toLowerCase() === 'connection') return;
    res.setHeader(name, value);
  });
}

async function proxyMcpRequest(req, res, state, upstreamUrl) {
  const body = req.method === 'POST' ? await readBody(req, 4 * 1024 * 1024) : Buffer.alloc(0);
  const deviceSecret = cleanString(req.headers[DEVICE_HEADER], 100);

  if (req.method === 'POST' && body.length > 0) {
    let rpc;
    try { rpc = JSON.parse(body.toString('utf8')); }
    catch { return sendJson(res, 400, { error: 'invalid JSON-RPC body' }); }

    const messages = Array.isArray(rpc) ? rpc : [rpc];
    for (const message of messages) {
      if (message?.method !== 'tools/call') continue;
      const authorization = authorizeToolCall(state, deviceSecret, message);
      if (!authorization.ok) {
        return sendJson(res, authorization.status, {
          error: 'Code Review capability denied',
          reason: authorization.reason,
        });
      }
    }
  }

  const upstream = new URL(upstreamUrl);
  const target = new URL(upstream.pathname + upstream.search, upstream.origin);
  const init = {
    method: req.method,
    headers: safeForwardHeaders(req.headers),
    redirect: 'manual',
  };
  if (body.length > 0) init.body = body;

  const upstreamResponse = await fetch(target, init);
  res.statusCode = upstreamResponse.status;
  copyResponseHeaders(upstreamResponse, res);
  if (!upstreamResponse.body) return res.end();
  Readable.fromWeb(upstreamResponse.body).pipe(res);
}

export function createCapabilityGatewayServer({ state = createGatewayState(), upstreamUrl = DEFAULT_UPSTREAM } = {}) {
  return http.createServer(async (req, res) => {
    try {
      if (!isLoopbackAddress(req.socket.remoteAddress)) {
        return sendJson(res, 403, { ok: false, error: 'loopback clients only' });
      }

      const requestUrl = new URL(req.url || '/', 'http://localhost');
      if (requestUrl.pathname.startsWith(CONTROL_PREFIX)) {
        setControlCors(req, res);
        if (req.method === 'OPTIONS') {
          if (!corsOrigin(req)) return sendJson(res, 403, { ok: false, error: 'extension origin required' });
          res.statusCode = 204;
          return res.end();
        }
        if (req.method !== 'POST' || !isExtensionControlRequest(req)) {
          return sendJson(res, 403, { ok: false, error: 'extension control request required' });
        }
        const deviceSecret = cleanString(req.headers[DEVICE_HEADER], 100);
        if (!validDeviceSecret(deviceSecret)) return sendJson(res, 401, { ok: false, error: 'device credential is invalid' });
        const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');

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
      await proxyMcpRequest(req, res, state, upstreamUrl);
    } catch (error) {
      if (!res.headersSent) {
        sendJson(res, 502, { error: error instanceof Error ? error.message : String(error) });
      } else {
        res.destroy(error instanceof Error ? error : new Error(String(error)));
      }
    }
  });
}

const isMain = process.argv[1] && new URL(import.meta.url).pathname === process.argv[1];
if (isMain) {
  const server = createCapabilityGatewayServer();
  server.listen(DEFAULT_PORT, DEFAULT_HOST, () => {
    console.log(`[code-review-gateway] listening on http://${DEFAULT_HOST}:${DEFAULT_PORT}/mcp`);
    console.log(`[code-review-gateway] upstream ${DEFAULT_UPSTREAM}`);
    console.log('[code-review-gateway] tools/call is DENY-by-default until the extension registers an active prompt-bound lease');
  });
}
