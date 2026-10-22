import type { PanelReply, PanelRequest, PanelStatus } from '../shared/panel';
import type { PrIdentity, ReviewError, ReviewReply, ReviewRequest } from '../shared/reviews';

export type PanelView = {
  open: boolean; busy: boolean; checking: boolean; status: PanelStatus | null;
  reply?: ReviewReply; error?: ReviewError; notice?: string;
};
export interface PanelTransport {
  panel(request: PanelRequest): Promise<PanelReply>;
  reviews(request: ReviewRequest): Promise<ReviewReply>;
  cancel(jobId?: string): Promise<unknown>;
}
export function createPanelSession(pr: PrIdentity, transport: PanelTransport, isCurrent: () => boolean) {
  let state: PanelView = { open: false, busy: false, checking: false, status: null };
  let generation = 0;
  let jobId: string | undefined;
  let disposed = false;
  const listeners = new Set<() => void>();
  function update(next: Partial<PanelView>) {
    if (disposed) return;
    state = { ...state, ...next }; listeners.forEach(listener => listener());
  }
  function stop() {
    generation++;
    if (state.busy) void transport.cancel(jobId);
    jobId = undefined;
  }
  function valid(current: number) { return !disposed && state.open && isCurrent() && current === generation; }
  async function authorize(current: number, retain: boolean): Promise<string | null> {
    const previous = state.status;
    update({ checking: true, busy: false, error: undefined });
    const result = await transport.panel({ type: 'panel.status', pr });
    if (!valid(current)) return null;
    if (!result.ok) {
      update({ checking: false, status: null, reply: undefined, error: result.error }); return null;
    }
    const status = result.status;
    const sameCredential = previous?.connected && status.connected && previous.revision === status.revision;
    update({ checking: false, status,
      ...(!retain || !sameCredential || (status.connected && status.health === 'invalid') ? { reply: undefined } : {}),
      ...(retain && !sameCredential ? { notice: 'Connection changed. Load reviews to use the current connection.' } : {}),
    });
    return status.connected && status.health !== 'invalid' ? status.revision : null;
  }
  async function load(refresh = false) {
    if (!state.open || disposed) return;
    stop(); const current = generation;
    update({ reply: undefined, notice: undefined });
    const revision = await authorize(current, false);
    if (!revision || !valid(current)) return;
    update({ busy: true });
    let result = await transport.reviews({ type: 'reviews.load', pr, refresh });
    while (valid(current)) {
      if ((result.revision || result.snapshot || result.partial || result.state === 'loading') && result.revision !== revision) {
        update({ reply: undefined, busy: false, error: { code: 'SUPERSEDED' } }); return;
      }
      const identity = result.identity ?? result.snapshot?.identity;
      if ((result.snapshot || result.partial) && !identity || identity && (identity.owner !== pr.owner || identity.repo !== pr.repo || identity.number !== pr.number)) {
        update({ reply: undefined, busy: false, error: { code: 'UNEXPECTED_RESPONSE' } }); return;
      }
      jobId = result.jobId;
      update({ reply: result, busy: result.state === 'loading' });
      if (result.state !== 'loading' || !jobId) break;
      result = await transport.reviews({ type: 'reviews.continue', jobId });
    }
    if (valid(current)) { jobId = undefined; update({ busy: false }); }
  }
  async function revalidate(clear = false) {
    if (disposed) return;
    const wasBusy = state.busy;
    stop(); const current = generation;
    update({ busy: false, ...(clear ? { reply: undefined, status: null, notice: 'Connection changed. Load reviews to use the current connection.' } : {}),
      ...(wasBusy && !clear ? { notice: 'Loading was interrupted. Load reviews to start again.' } : {}),
    });
    if (state.open) await authorize(current, !clear);
  }
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    open() { update({ open: true }); void load(); },
    close() { stop(); update({ open: false, busy: false, checking: false, reply: undefined, error: undefined }); },
    load,
    cancel() { stop(); update({ busy: false, notice: 'Loading cancelled. Partial results are incomplete.' }); },
    revalidate,
    suspend() { const wasBusy = state.busy; stop(); update({ busy: false, checking: true, ...(wasBusy ? { notice: 'Loading was interrupted. Load reviews to start again.' } : {}) }); },
    async openSettings() {
      const current = generation;
      const result = await transport.panel({ type: 'panel.openSettings', pr });
      if (valid(current) && !result.ok) update({ error: result.error });
    },
    dispose() { stop(); disposed = true; listeners.clear(); },
  };
}
export type PanelSession = ReturnType<typeof createPanelSession>;
