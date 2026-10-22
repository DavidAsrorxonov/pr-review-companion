import { defineManifest } from '@crxjs/vite-plugin';
import packageJson from './package.json' with { type: 'json' };

const icons = {
  16: 'icons/icon-16.png',
  32: 'icons/icon-32.png',
  48: 'icons/icon-48.png',
  128: 'icons/icon-128.png',
};

export default defineManifest({
  manifest_version: 3,
  name: 'PR Review Companion',
  description: 'A companion for GitHub pull-request reviews. Unresolved review threads on GitHub.',
  version: packageJson.version,
  icons,
  action: {
    default_title: 'PR Review Companion',
    default_popup: 'src/popup/popup.html',
    default_icon: icons,
  },
  options_ui: { page: 'src/options/options.html', open_in_tab: true },
  background: { service_worker: 'src/background/service-worker.ts', type: 'module' },
  content_scripts: [{
    matches: ['https://github.com/*'],
    js: ['src/content/index.ts'],
    run_at: 'document_idle',
    all_frames: false,
    world: 'ISOLATED',
  }],
  permissions: ['storage', 'alarms'],
  host_permissions: ['https://api.github.com/*', 'https://github.com/*'],
  optional_permissions: ['notifications'],
  content_security_policy: {
    extension_pages: "script-src 'self'; object-src 'self'",
  },
});
