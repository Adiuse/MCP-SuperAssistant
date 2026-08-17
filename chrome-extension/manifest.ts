import { readFileSync } from 'node:fs';

const packageJson = JSON.parse(readFileSync('./package.json', 'utf8'));

const manifest = {
  manifest_version: 3,
  default_locale: 'en',
  name: 'MCP SuperAssistant',
  browser_specific_settings: {
    gecko: {
      id: 'saurabh@mcpsuperassistant.ai',
    },
  },
  version: packageJson.version,
  description: 'MCP SuperAssistant',
  host_permissions: [
    '*://*.github.com/*',
    '*://*.copilot.github.com/*',
    'http://localhost/*',
    'http://127.0.0.1/*',
  ],
  permissions: ['storage', 'clipboardWrite', 'notifications', 'alarms'],
  background: {
    service_worker: 'background.js',
    type: 'module',
  },
  icons: {
    128: 'icon-128.png',
    34: 'icon-34.png',
    16: 'icon-16.png',
  },
} satisfies chrome.runtime.ManifestV3;

export default manifest;
