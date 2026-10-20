import { createAuthController } from './auth/controller';
import { createAuthApi } from './auth/github';

// Initialization starts now, but handlers are registered before any awaits.
const auth = createAuthController({
  storage: chrome.storage.local,
  api: createAuthApi(),
  extensionId: chrome.runtime.id,
});

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  void auth.handle(message, sender).then(sendResponse);
  return true; // Keep the response channel open during asynchronous validation.
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
