import { describe, expect, it, vi } from 'vitest';
import { createPanelSession } from './session';
import type { PanelTransport } from './session';
import type { PanelReply } from '../shared/panel';
import type { ReviewReply } from '../shared/reviews';
import { deferred, identity } from '../background/reviews/fixtures.test-support';
import { groupUnresolved } from './components/ThreadList';

const revision = '00000000-0000-4000-8000-000000000001';
const connected: PanelReply = { ok: true, status: { connected: true, health: 'verified', revision } };
const complete: ReviewReply = { ok: true, state: 'complete', complete: true, revision, freshness: 'fresh', persistence: 'cached', snapshot: {
  identity, fetchedAt: 1000, complete: true, data: { pr: { id: 'PR1', number: 123, title: 'PR title', url: 'https://github.com/octocat/hello-world/pull/123', state: 'OPEN', isDraft: false }, threads: [] },
} };
function setup() {
  const transport = { panel: vi.fn<PanelTransport['panel']>().mockResolvedValue(connected),
    reviews: vi.fn<PanelTransport['reviews']>().mockResolvedValue(complete), cancel: vi.fn<PanelTransport['cancel']>().mockResolvedValue(undefined) };
  let current = true;
  const session = createPanelSession(identity, transport, () => current);
  return { transport, session, leave: () => { current = false; } };
}
describe('panel load lifecycle', () => {
  it('makes no calls while collapsed and uses explicit opening to load', async () => {
    const s = setup(); await s.session.revalidate(); expect(s.transport.panel).not.toHaveBeenCalled();
    s.session.open(); await vi.waitFor(() => expect(s.session.getSnapshot().reply?.complete).toBe(true));
    expect(s.transport.reviews).toHaveBeenCalledWith({ type: 'reviews.load', pr: identity, refresh: false });
  });
  it('does not fetch with disconnected or invalid credentials', async () => {
    for (const status of [{ connected: false } as const, { connected: true, health: 'invalid', revision } as const]) {
      const s = setup(); s.transport.panel.mockResolvedValue({ ok: true, status }); s.session.open();
      await vi.waitFor(() => expect(s.session.getSnapshot().checking).toBe(false)); expect(s.transport.reviews).not.toHaveBeenCalled();
    }
  });
  it.each(['close', 'leave', 'invalidate', 'dispose'])('discards a pending result on %s', async action => {
    const s = setup(); const gate = deferred<ReviewReply>(); s.transport.reviews.mockReturnValueOnce(gate.promise);
    s.session.open(); await vi.waitFor(() => expect(s.transport.reviews).toHaveBeenCalledOnce());
    if (action === 'close') s.session.close();
    else if (action === 'leave') s.leave();
    else if (action === 'invalidate') { await s.session.revalidate(true); expect(s.session.getSnapshot().notice).toContain('Connection changed'); }
    else s.session.dispose();
    gate.resolve(complete); await Promise.resolve(); await Promise.resolve();
    expect(s.session.getSnapshot().reply).toBeUndefined();
  });
  it('rejects replies from another credential revision or PR', async () => {
    for (const reply of [{ ...complete, revision: crypto.randomUUID() }, { ...complete, revision: undefined },
      { ...complete, snapshot: { ...complete.snapshot!, identity: { ...identity, number: 124 } } }]) {
      const s = setup(); s.transport.reviews.mockResolvedValue(reply); s.session.open();
      await vi.waitFor(() => expect(s.session.getSnapshot().busy).toBe(false));
      await vi.waitFor(() => expect(s.session.getSnapshot().error).toBeDefined()); expect(s.session.getSnapshot().reply).toBeUndefined();
    }
  });
  it('focus revalidation hides retained data until checked, and never fetches GitHub', async () => {
    const s = setup(); s.session.open(); await vi.waitFor(() => expect(s.session.getSnapshot().reply).toBeDefined());
    const gate = deferred<PanelReply>(); s.transport.panel.mockReturnValueOnce(gate.promise);
    const pending = s.session.revalidate(); expect(s.session.getSnapshot().checking).toBe(true);
    gate.resolve(connected); await pending;
    expect(s.session.getSnapshot().reply?.complete).toBe(true); expect(s.transport.reviews).toHaveBeenCalledOnce();
    s.transport.panel.mockResolvedValue({ ok: true, status: { connected: true, health: 'verified', revision: crypto.randomUUID() } });
    await s.session.revalidate(); expect(s.session.getSnapshot().reply).toBeUndefined(); expect(s.transport.reviews).toHaveBeenCalledOnce();
  });
  it('continuations stop on cancellation and cannot overwrite a newer load', async () => {
    const s = setup(); const gate = deferred<ReviewReply>();
    s.transport.reviews.mockResolvedValueOnce({ ok: true, state: 'loading', complete: false, freshness: 'none', persistence: 'none', revision, jobId: crypto.randomUUID() })
      .mockReturnValueOnce(gate.promise);
    s.session.open(); await vi.waitFor(() => expect(s.transport.reviews).toHaveBeenCalledTimes(2));
    s.session.cancel(); expect(s.transport.cancel).toHaveBeenCalledOnce();
    await s.session.load(true); gate.resolve({ ...complete, revision: crypto.randomUUID() });
    await Promise.resolve(); expect(s.session.getSnapshot().reply).toEqual(complete);
  });
});
it('groups only unresolved threads by file, including outdated discussions', () => {
  const base = { id: '1', path: 'b.ts', line: null, originalLine: null, startLine: null, originalStartLine: null,
    diffSide: 'RIGHT' as const, startDiffSide: null, comments: [], isResolved: false, isOutdated: true };
  expect(groupUnresolved([base, { ...base, id: '2', path: 'a.ts' }, { ...base, id: '3', isResolved: true }]).map(([path, threads]) => [path, threads.length]))
    .toEqual([['a.ts', 1], ['b.ts', 1]]);
});
