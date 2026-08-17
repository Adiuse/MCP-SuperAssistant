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
    '*://*.chat.openai.com/*',
    '*://*.chatgpt.com/*',
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
  content_scripts: [
    {
      matches: ['*://*.chat.openai.com/*', '*://*.chatgpt.com/*'],
      js: ['content/index.iife.js'],
      run_at: 'document_idle',
    },
    {
      matches: ['*://*.github.com/*', '*://*.copilot.github.com/*'],
      js: ['content/index.iife.js'],
      run_at: 'document_idle',
    },
  ],
  web_accessible_resources: [
    {
      resources: ['*.js', '*.css', 'content/*.css', '*.svg', 'icon-128.png', 'icon-34.png', 'icon-16.png'],
      matches: ['*://*/*'],
    },
  ],
} satisfies chrome.runtime.ManifestV3;

export default manifest;
