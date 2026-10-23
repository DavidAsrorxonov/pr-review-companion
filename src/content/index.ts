import { createRouteCoordinator, watchNavigation } from './navigation';
import type { MountedPanel } from './navigation';
import { mountUnavailable } from './domAnchors';
import { noteDrafts } from './noteDrafts';

const coordinator = createRouteCoordinator(() => location.href, (pr, isCurrent) => {
  let mounted: MountedPanel | undefined;
  let disposed = false;
  // React, schema validation, and panel CSS load only after entering a PR route.
  void import('./mountPanel').then(({ mountPanel }) => {
    if (!disposed && isCurrent()) mounted = mountPanel(pr, isCurrent);
  }).catch(() => {
    if (!disposed && isCurrent()) mounted = mountUnavailable();
  });
  return {
    restore() { mounted?.restore(); },
    navigated() { mounted?.navigated?.(); },
    notesChanged() { mounted?.notesChanged?.(); },
    async revalidate(clear) { await mounted?.revalidate(clear); },
    suspend() { mounted?.suspend(); },
    destroy() { disposed = true; mounted?.destroy(); },
  };
});
// Isolated-world singleton; never communicate with page scripts or patch history.
const scope = globalThis as typeof globalThis & { __prrcCleanup?: () => void };
scope.__prrcCleanup?.();
const stop = watchNavigation(coordinator);
const onMessage = (raw: unknown, sender: chrome.runtime.MessageSender) => {
  if (sender.id !== chrome.runtime.id || sender.url !== undefined && !sender.url.startsWith(`chrome-extension://${chrome.runtime.id}/`)) return;
  if (typeof raw === 'object' && raw !== null && 'type' in raw) {
    if (raw.type === 'panel.invalidate') { noteDrafts.clear(); coordinator.revalidate(true); }
    if (raw.type === 'notes.invalidate') coordinator.notesChanged();
  }
};
chrome.runtime.onMessage.addListener(onMessage);
scope.__prrcCleanup = () => { noteDrafts.clear(); stop(); chrome.runtime.onMessage.removeListener(onMessage); };
