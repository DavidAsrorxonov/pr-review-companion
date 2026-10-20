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
