import type { DiscussionLink } from '../shared/threadLinks';

export type JumpOutcome = { state: 'found' | 'cancelled' } | { state: 'unavailable'; url?: string };
export type JumpView = { state: 'idle' | 'searching' | 'found' | 'unavailable'; message: string; url?: string };
export interface JumpEnvironment<T> {
  valid(revision: string): boolean;
  find(links: DiscussionLink[]): T | null;
  observe(check: () => void): () => void;
  collapse(): void;
  // Return cleanup for the highlight, position tracking, and temporary focus attributes.
  reveal(target: T, valid: () => boolean, finish: () => void): () => void;
}

export function createThreadJump<T>(env: JumpEnvironment<T>) {
  let generation = 0;
  let view: JumpView = { state: 'idle', message: '' };
  const listeners = new Set<() => void>();
  let cleanup = () => {};
  let pending: ((outcome: JumpOutcome) => void) | undefined;
  function update(next: JumpView) { view = next; listeners.forEach(listener => listener()); }
  function cancel() {
    generation++; cleanup(); cleanup = () => {};
    pending?.({ state: 'cancelled' }); pending = undefined;
    update({ state: 'idle', message: '' });
  }
  return {
    getSnapshot: () => view,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    cancel,
    jump(links: DiscussionLink[], revision: string): Promise<JumpOutcome> {
      cancel(); const current = generation;
      const valid = () => current === generation && env.valid(revision);
      if (!valid()) return Promise.resolve({ state: 'cancelled' });
      update({ state: 'searching', message: 'Finding discussion on this page…' });
      return new Promise(resolve => {
        pending = resolve;
        let settled = false;
        let stopObserving = () => {};
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const stopSearch = () => { stopObserving(); clearTimeout(timeout); };
        cleanup = stopSearch;
        function check(): boolean {
          if (settled || current !== generation) return true;
          if (!valid()) { cancel(); return true; }
          const target = env.find(links);
          if (!valid()) { cancel(); return true; }
          if (!target) return false;
          settled = true; stopSearch(); pending = undefined;
          env.collapse();
          // Collapsing intentionally stops pagination; it must not redirect focus to the launcher.
          if (!valid()) { cancel(); resolve({ state: 'cancelled' }); return true; }
          cleanup = env.reveal(target, valid, () => { if (current === generation) cancel(); });
          update({ state: 'found', message: 'Discussion found. Focus moved to the GitHub comment.' });
          resolve({ state: 'found' }); return true;
        }
        if (check()) return;
        stopObserving = env.observe(check);
        timeout = setTimeout(() => {
          if (check()) return;
          settled = true; stopSearch(); cleanup = () => {}; pending = undefined;
          const url = links[0]?.url;
          update({ state: 'unavailable', message: 'This discussion isn’t available on the current page.', url });
          resolve({ state: 'unavailable', url });
        }, 2000);
      });
    },
    dispose() { cancel(); listeners.clear(); },
  };
}
export type ThreadJump = ReturnType<typeof createThreadJump>;
