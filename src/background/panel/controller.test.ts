import { describe, expect, it, vi } from 'vitest';
import { createPanelController } from './controller';
import { deferred, extensionId, identity, page, response, sender, setup, token } from '../reviews/fixtures.test-support';

const prUrl = 'https://github.com/octocat/hello-world/pull/123';
const content = { id: extensionId, origin: 'https://github.com', url: 'https://github.com/octocat/hello-world',
  frameId: 0, documentId: 'github-document', documentLifecycle: 'active' as const, tab: { id: 4 } };
const request = { type: 'reviews.load', pr: identity };
function fixture() {
  const getTab = vi.fn().mockResolvedValue({ url: prUrl });
  const s = setup(getTab);
  const openSettings = vi.fn().mockResolvedValue(undefined);
  const panel = createPanelController({ credentials: s.auth.credentials, extensionId, getTab, openSettings });
  return { ...s, getTab, openSettings, panel, read: () => s.reviews.handle(request, content) };
}
describe('route-bound content review access', () => {
  it('authorizes the current PR after SPA navigation from a repository homepage', async () => {
    const s = fixture(); await s.connect();
    expect(await s.read()).toMatchObject({ complete: true });
    expect(s.getTab).toHaveBeenCalledWith(4);
  });
  it.each([
    { ...content, frameId: 1 }, { ...content, documentId: undefined }, { ...content, id: 'other' },
    { ...content, origin: 'https://evil.test' }, { ...content, url: 'https://evil.test' },
    { ...content, documentLifecycle: 'cached' as const }, { ...content, documentLifecycle: undefined },
    { ...content, tab: undefined }, { ...content, tab: { id: -1 } },
  ])('rejects an untrusted content context %#', async caller => {
    const s = fixture(); await s.connect();
    expect(await s.reviews.handle(request, caller)).toMatchObject({ error: { code: 'FORBIDDEN_CALLER' } });
    expect(s.fetcher).not.toHaveBeenCalled();
  });
  it.each(['https://github.com/octocat/hello-world', 'https://github.com/octocat/hello-world/pull/124',
    'https://github.com/other/repo/pull/123', 'https://evil.test/'])('rejects a mismatched current tab URL %s', async url => {
    const s = fixture(); await s.connect(); s.getTab.mockResolvedValue({ url });
    expect(await s.read()).toMatchObject({ error: { code: 'FORBIDDEN_CALLER' } });
    expect(s.fetcher).not.toHaveBeenCalled();
  });
  it('fails closed when tab inspection fails or navigation is pending elsewhere', async () => {
    const s = fixture(); await s.connect(); s.getTab.mockRejectedValueOnce(new Error(token));
    expect(await s.read()).toMatchObject({ error: { code: 'FORBIDDEN_CALLER' } });
    s.getTab.mockResolvedValue({ url: prUrl, pendingUrl: 'https://example.com' });
    expect(await s.read()).toMatchObject({ error: { code: 'FORBIDDEN_CALLER' } });
  });
  it('rejects cached reads when the caller is on another PR', async () => {
    const s = fixture(); await s.connect(); await s.load();
    s.getTab.mockResolvedValue({ url: prUrl.replace('123', '124') });
    const reply = await s.read(); expect(reply.snapshot).toBeUndefined();
    expect(reply.error?.code).toBe('FORBIDDEN_CALLER'); expect(s.fetcher).toHaveBeenCalledOnce();
  });
  it('suppresses a late network result after navigation', async () => {
    const s = fixture(); await s.connect(); const gate = deferred<Response>(); s.fetcher.mockReturnValueOnce(gate.promise);
    const pending = s.read(); await vi.waitFor(() => expect(s.fetcher).toHaveBeenCalledOnce());
    s.getTab.mockResolvedValue({ url: 'https://github.com/octocat/hello-world' });
    s.reviews.tabChanged(4, 'https://github.com/octocat/hello-world'); gate.resolve(response(page()));
    const reply = await pending; expect(reply.snapshot).toBeUndefined(); expect(reply.partial).toBeUndefined(); expect(reply.complete).toBe(false);
  });
  it('binds continuations/cancellation to the tab and document, allowing cancellation after leaving the PR', async () => {
    const s = fixture(); await s.connect(); s.fetcher.mockResolvedValueOnce(response(page([], 'next')));
    const initial = await s.read();
    expect(await s.reviews.handle({ type: 'reviews.continue', jobId: initial.jobId }, { ...content, documentId: 'other-document' }))
      .toMatchObject({ error: { code: 'INTERRUPTED' } });
    await s.reviews.handle({ type: 'reviews.cancel', jobId: initial.jobId }, { ...content, tab: { id: 5 } });
    s.getTab.mockResolvedValue({ url: 'https://github.com/octocat/hello-world' });
    expect(await s.reviews.handle({ type: 'reviews.cancel', jobId: initial.jobId }, content)).toMatchObject({ state: 'cancelled' });
    expect(await s.reviews.handle({ type: 'reviews.continue', jobId: initial.jobId }, content)).toMatchObject({ error: { code: 'INTERRUPTED' } });
  });
  it('tab closure aborts its jobs without cancelling the settings preview', async () => {
    const s = fixture(); await s.connect(); s.fetcher.mockResolvedValueOnce(response(page([], 'next')));
    const initial = await s.read(); s.reviews.tabChanged(4);
    expect(await s.reviews.handle({ type: 'reviews.continue', jobId: initial.jobId }, content)).toMatchObject({ error: { code: 'INTERRUPTED' } });
    expect(await s.load()).toMatchObject({ complete: true });
  });
});
describe('minimal panel operations', () => {
  it('returns availability without identity or credentials, including disconnected status', async () => {
    const s = fixture();
    expect(await s.panel.handle({ type: 'panel.status', pr: identity }, content)).toEqual({ ok: true, status: { connected: false } });
    await s.connect(); const reply = await s.panel.handle({ type: 'panel.status', pr: identity }, content);
    expect(reply).toMatchObject({ status: { connected: true, health: 'verified' } });
    expect(JSON.stringify(reply)).not.toContain(token); expect(JSON.stringify(reply)).not.toContain('octocat');
    expect(s.fetcher).not.toHaveBeenCalled();
  });
  it('opens only the fixed options page from a valid PR context', async () => {
    const s = fixture();
    expect(await s.panel.handle({ type: 'panel.openSettings', pr: identity }, content)).toMatchObject({ ok: true });
    expect(s.openSettings).toHaveBeenCalledOnce();
    expect(await s.panel.handle({ type: 'panel.openSettings', pr: identity, url: 'https://evil.test' }, content)).toMatchObject({ error: { code: 'INVALID_REQUEST' } });
    expect(await s.panel.handle({ type: 'panel.openSettings', pr: identity }, sender)).toMatchObject({ error: { code: 'FORBIDDEN_CALLER' } });
    expect(s.openSettings).toHaveBeenCalledOnce();
  });
  it('keeps all auth operations denied to content scripts', async () => {
    const s = fixture(); await s.connect();
    for (const type of ['auth.status', 'auth.connect', 'auth.disconnect', 'auth.recheck', 'auth.checkRepository']) {
      expect(await s.auth.handle({ type, token }, content)).toMatchObject({ error: { code: 'FORBIDDEN_CALLER' } });
    }
  });
});
