import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');

const [settingsSource, popoverSource] = await Promise.all([
  fs.readFile(path.join(repoRoot, 'pages/content/src/components/McpConnectionSettingsFa.tsx'), 'utf8'),
  fs.readFile(path.join(repoRoot, 'pages/content/src/components/mcpPopover/mcpPopover.tsx'), 'utf8'),
]);

assert.match(
  settingsSource,
  /http:\/\/127\.0\.0\.1:38106\/mcp/,
  'visible MCP connection settings must expose the secure loopback gateway URL',
);
assert.match(settingsSource, /Streamable HTTP/, 'visible MCP connection settings must show Streamable HTTP explicitly');
assert.match(
  settingsSource,
  /قابل تغییر نیستند/,
  'visible MCP settings must explain that endpoint and transport are security-locked',
);
assert.doesNotMatch(settingsSource, /<input|<select|updateServerConfig/);
assert.match(settingsSource, /event\.nativeEvent\.isTrusted/);
assert.match(
  popoverSource,
  /<McpConnectionSettingsFa \/>/,
  'the current MCP control-center popover must render connection settings instead of hiding them in the legacy sidebar',
);

console.log('✓ Current MCP control center exposes secure gateway URL + transport settings and reconnect action');
