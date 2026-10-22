import { parsePrUrl } from '../shared/prUrl';
import type { PrIdentity } from '../shared/prUrl';

export const routeKey = (pr: PrIdentity | null) => pr ? `${pr.owner}/${pr.repo}#${pr.number}` : null;
export interface MountedPanel { restore(): void; destroy(): void; revalidate(clear?: boolean): Promise<void>; suspend(): void; navigated?(): void }
export function createRouteCoordinator(readUrl: () => string, mount: (pr: PrIdentity, isCurrent: () => boolean) => MountedPanel) {
  let key: string | null = null;
  let mounted: MountedPanel | undefined;
  let generation = 0;
  let previousUrl: string | undefined;
  return {
    sync() {
      const url = readUrl(); const pr = parsePrUrl(url); const next = routeKey(pr);
      if (url !== previousUrl) mounted?.navigated?.();
      previousUrl = url;
      if (next !== key) {
        generation++; mounted?.destroy(); mounted = undefined; key = next;
        if (pr) {
          const expected = generation;
          mounted = mount(pr, () => generation === expected && routeKey(parsePrUrl(readUrl())) === next);
        }
      }
      mounted?.restore();
    },
    revalidate(clear = false) { void mounted?.revalidate(clear); },
    suspend() { mounted?.suspend(); },
    destroy() { generation++; mounted?.destroy(); mounted = undefined; key = null; },
  };
}
export function watchNavigation(coordinator: ReturnType<typeof createRouteCoordinator>) {
  const sync = () => coordinator.sync();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const observer = new MutationObserver(() => {
    if (timer !== undefined) return;
    timer = setTimeout(() => { timer = undefined; sync(); }, 50);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  const navigation = (window as Window & { navigation?: EventTarget }).navigation;
  navigation?.addEventListener('currententrychange', sync);
  const documentEvents = ['turbo:load', 'turbo:render', 'pjax:end'];
  documentEvents.forEach(name => document.addEventListener(name, sync));
  window.addEventListener('popstate', sync); window.addEventListener('hashchange', sync);
  const resume = () => { sync(); coordinator.revalidate(); };
  const suspend = () => coordinator.suspend();
  const visibility = () => document.visibilityState === 'visible' ? resume() : suspend();
  window.addEventListener('pageshow', resume); window.addEventListener('pagehide', suspend);
  window.addEventListener('focus', resume); document.addEventListener('visibilitychange', visibility);
  sync();
  return () => {
    observer.disconnect(); clearTimeout(timer);
    navigation?.removeEventListener('currententrychange', sync);
    documentEvents.forEach(name => document.removeEventListener(name, sync));
    window.removeEventListener('popstate', sync); window.removeEventListener('hashchange', sync);
    window.removeEventListener('pageshow', resume); window.removeEventListener('pagehide', suspend);
    window.removeEventListener('focus', resume); document.removeEventListener('visibilitychange', visibility);
    coordinator.destroy();
  };
}
