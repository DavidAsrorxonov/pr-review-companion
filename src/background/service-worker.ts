import { createAuthController } from './auth/controller';
import { createAuthApi } from './auth/github';
import { createReviewApi } from './reviews/github';
import { createReviewController } from './reviews/controller';
import { createPanelController } from './panel/controller';
import { createNotesController } from './notes/controller';
import { parsePrUrl } from '../shared/prUrl';
import { samePr } from './panel/access';

// Initialization starts now, but handlers are registered before any awaits.
const auth = createAuthController({
  storage: chrome.storage.local,
  api: createAuthApi(),
  extensionId: chrome.runtime.id,
});

const reviews = createReviewController({
  credentials: auth.credentials, storage: chrome.storage.local,
  api: createReviewApi(), extensionId: chrome.runtime.id, getTab: id => chrome.tabs.get(id),
});

const panel = createPanelController({
  credentials: auth.credentials, extensionId: chrome.runtime.id,
  getTab: id => chrome.tabs.get(id), openSettings: () => chrome.runtime.openOptionsPage(),
});

const notes = createNotesController({
  account: auth.localAccount, storage: chrome.storage.local, extensionId: chrome.runtime.id,
  getTab: id => chrome.tabs.get(id),
  async changed(pr) {
    const tabs = await chrome.tabs.query({ url: 'https://github.com/*' });
    await Promise.allSettled(tabs.filter(tab => tab.id !== undefined && samePr(parsePrUrl(tab.url ?? ''), pr))
      .map(tab => chrome.tabs.sendMessage(tab.id!, { type: 'notes.invalidate' }, { frameId: 0 })));
  },
});

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  const type = typeof message === 'object' && message !== null && 'type' in message && typeof message.type === 'string' ? message.type : '';
  const handler = type.startsWith('notes.') ? notes : type.startsWith('reviews.') ? reviews : type.startsWith('panel.') ? panel : auth;
  void handler.handle(message, sender).then(sendResponse);
  return true;
});
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.url) reviews.tabChanged(tabId, change.url);
});
chrome.tabs.onRemoved.addListener(tabId => reviews.tabChanged(tabId));
auth.credentials.onChange(() => {
  // Discover tabs each time: an earlier worker may have served their panels.
  void chrome.tabs.query({ url: 'https://github.com/*' }).then(tabs => Promise.allSettled(
    tabs.filter(tab => tab.id !== undefined).map(tab => chrome.tabs.sendMessage(tab.id!, { type: 'panel.invalidate' }, { frameId: 0 })),
  )).catch(() => undefined);
});

// Register listeners synchronously so Chrome can wake the worker for each event.
chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (import.meta.env.DEV) {
    console.debug('[PR Review Companion] Installed:', reason);
  }
});

chrome.runtime.onStartup.addListener(() => {
  if (import.meta.env.DEV) {
    console.debug('[PR Review Companion] Browser started');
  }
});

export {};
