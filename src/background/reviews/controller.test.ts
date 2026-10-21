import { describe, expect, it, vi } from 'vitest';
import { counts, reviewReplySchema } from '../../shared/reviews';
import { AuthFailure } from '../auth/errors';
import { REVIEW_CACHE_KEY, GRAPHQL_RETRY_KEY, SECONDARY_RETRY_KEY } from './keys';
import { CACHE_TTL } from './cache';
import { comment, deferred, identity, origin, page, pageInfo, response, sender, setup, thread, token } from './fixtures.test-support';

const continueLoad = (s: ReturnType<typeof setup>, jobId: string, caller = sender) => s.reviews.handle({ type: 'reviews.continue', jobId }, caller);

describe('review boundary', () => {
  it.each([
    { ...sender, id: 'other' }, { ...sender, url: 'https://github.com/octocat/hello-world/pull/123' },
    { ...sender, url: `${origin}/src/popup/popup.html` }, { ...sender, url: `${sender.url}?x=1` },
    { ...sender, origin: 'https://github.com' }, { ...sender, frameId: 1 }, { ...sender, documentId: undefined }, {},
  ])('rejects untrusted caller %#', async caller => {
    const s = setup(); await s.connect();
    expect(await s.reviews.handle({ type: 'reviews.load', pr: identity }, caller)).toMatchObject({ error: { code: 'FORBIDDEN_CALLER' } });
    expect(s.fetcher).not.toHaveBeenCalled();
  });
  it.each([null, { type: 'reviews.fetch' }, { type: 'reviews.load', pr: { ...identity, number: 0 } },
    { type: 'reviews.load', pr: identity, token }, { type: 'reviews.load', pr: identity, query: 'query { viewer { id } }' },
    { type: 'reviews.continue', jobId: 'bad', cursor: 'cursor' }])('rejects malformed request %#', async raw => {
    const s = setup(); await s.connect();
    expect(await s.reviews.handle(raw, sender)).toMatchObject({ error: { code: 'INVALID_REQUEST' } });
    expect(s.fetcher).not.toHaveBeenCalled();
  });
  it('fails closed on storage initialization failure', async () => {
    const s = setup(); s.storage.setAccessLevel.mockRejectedValueOnce(new Error(token));
    const restarted = s.restart();
    expect(await restarted.reviews.handle({ type: 'reviews.load', pr: identity }, sender)).toMatchObject({ error: { code: 'STORAGE' } });
    expect(s.fetcher).not.toHaveBeenCalled();
  });
  it('requires a credential and does not disclose raw network errors', async () => {
    const s = setup(); expect(await s.load()).toMatchObject({ error: { code: 'NOT_CONNECTED' } });
    await s.connect(); s.fetcher.mockRejectedValueOnce(new Error(token));
    const reply = await s.load();
    expect(reply).toMatchObject({ error: { code: 'NETWORK' } });
    expect(JSON.stringify(reply)).not.toContain(token);
    expect(reviewReplySchema.safeParse(reply).success).toBe(true);
  });
});

describe('complete pagination', () => {
  it('handles empty PRs without treating an incomplete page as empty success', async () => {
    const s = setup(); await s.connect(); s.fetcher.mockResolvedValueOnce(response(page([])));
    expect(await s.load()).toMatchObject({ complete: true, snapshot: { data: { threads: [] } } });
  });
  it('loads 125 threads and 125 published comments in one thread, deduplicating IDs', async () => {
    const s = setup(); await s.connect();
    for (let p = 0; p < 5; p++) {
      const nodes = Array.from({ length: 25 }, (_, i) => thread(`T${p * 25 + i}`, [comment(`C${p * 25 + i}`)]));
      if (p === 0) nodes[0] = thread('T0', Array.from({ length: 20 }, (_, i) => comment(`long${i}`)), 'c20');
      if (p === 1) nodes.push(thread('T0'));
      s.fetcher.mockResolvedValueOnce(response(page(nodes, p < 4 ? `t${p}` : null)));
      if (p === 0) {
        s.fetcher.mockResolvedValueOnce(response({ data: { node: { id: 'T0', comments: {
          nodes: Array.from({ length: 100 }, (_, i) => comment(`long${20 + i}`)), pageInfo: pageInfo('c120'),
        } } } }));
        s.fetcher.mockResolvedValueOnce(response({ data: { node: { id: 'T0', comments: {
          nodes: [comment('long119'), ...Array.from({ length: 5 }, (_, i) => comment(`long${120 + i}`)), comment('draft', 'PENDING')], pageInfo: pageInfo(),
        } } } }));
      }
    }
    let reply = await s.load();
    expect(reply.complete).toBe(false);
    while (reply.jobId) reply = await continueLoad(s, reply.jobId);
    expect(reply).toMatchObject({ complete: true, progress: { pages: 7, threads: 125, comments: 249 } });
    expect(reply.snapshot?.data.threads[0]?.comments).toHaveLength(125);
    expect(reviewReplySchema.safeParse(reply).success).toBe(true);
    expect(JSON.stringify(reply)).not.toContain(token);
  });
  it('accepts deleted authors and outdated/null positions', async () => {
    const s = setup(); await s.connect();
    const item = { ...thread(), isResolved: true, isOutdated: true, line: null, originalLine: null,
      comments: { nodes: [{ ...comment(), author: null }], pageInfo: pageInfo() } };
    s.fetcher.mockResolvedValueOnce(response(page([item])));
    const reply = await s.load();
    expect(reply.snapshot && counts(reply.snapshot.data)).toEqual({ total: 1, resolved: 1, unresolved: 0, outdated: 1, comments: 1 });
  });
  it.each(['repeat', 'missing', 'partial', 'malformed'])('does not advance after a %s page', async mode => {
    const s = setup(); await s.connect(); s.fetcher.mockResolvedValueOnce(response(page([thread()], 'next')));
    const first = await s.load();
    const body = page([thread('T2')], mode === 'repeat' ? 'next' : 'new');
    if (mode === 'missing') body.data.repository.pullRequest.reviewThreads.pageInfo.endCursor = null;
    s.fetcher.mockResolvedValueOnce(mode === 'malformed' ? new Response('invalid JSON')
      : response(mode === 'partial' ? { ...body, errors: [{ message: `raw ${token}` }] } : body));
    const result = await continueLoad(s, first.jobId!);
    expect(result).toMatchObject({ complete: false, state: 'error', progress: { pages: 1, threads: 1 } });
    expect(JSON.stringify(result)).not.toContain(token);
  });
  it('rejects repeated nested comment cursors', async () => {
    const s = setup(); await s.connect(); s.fetcher.mockResolvedValueOnce(response(page([thread('T1', [comment()], 'c1')])));
    const first = await s.load();
    s.fetcher.mockResolvedValueOnce(response({ data: { node: { id: 'T1', comments: { nodes: [comment('C2')], pageInfo: pageInfo('c1') } } } }));
    expect(await continueLoad(s, first.jobId!)).toMatchObject({ complete: false, error: { code: 'INCOMPLETE' }, progress: { pages: 1 } });
  });
});

describe('cache and access lifecycle', () => {
  it('reuses fresh cache across worker restart and refreshes when stale or forced', async () => {
    const s = setup(); await s.connect(); await s.load(); await s.load();
    expect(s.fetcher).toHaveBeenCalledTimes(1);
    const restarted = s.restart();
    expect(await restarted.reviews.handle({ type: 'reviews.load', pr: identity }, sender)).toMatchObject({ complete: true, persistence: 'cached' });
    expect(s.fetcher).toHaveBeenCalledTimes(1);
    s.advance(CACHE_TTL + 1); await s.load(); await s.load(true);
    expect(s.fetcher).toHaveBeenCalledTimes(3);
  });
  it('preserves a last complete result after refresh failure', async () => {
    const s = setup(); await s.connect(); const first = await s.load();
    s.fetcher.mockRejectedValueOnce(new Error('offline'));
    const reply = await s.load(true);
    expect(reply).toMatchObject({ complete: false, state: 'error', freshness: 'stale', snapshot: first.snapshot, error: { code: 'NETWORK' } });
  });
  it.each([403, 404])('purges inaccessible cache on %s and does not serve it on the next load', async status => {
    const s = setup(); await s.connect(); await s.load();
    s.fetcher.mockResolvedValueOnce(response({ message: 'inaccessible' }, status));
    const reply = await s.load(true);
    expect(reply.snapshot).toBeUndefined(); expect(reply.partial).toBeUndefined();
    expect(s.data[REVIEW_CACHE_KEY]).toMatchObject({ entries: [] });
    await s.load(); expect(s.fetcher).toHaveBeenCalledTimes(3);
  });
  it('suppresses data on invalid credentials and survives a restart', async () => {
    const s = setup(); await s.connect(); await s.load();
    s.fetcher.mockResolvedValueOnce(response({}, 401));
    expect(await s.load(true)).toMatchObject({ error: { code: 'INVALID_TOKEN' } });
    const result = await s.restart().reviews.handle({ type: 'reviews.load', pr: identity }, sender);
    expect(result).toMatchObject({ error: { code: 'INVALID_TOKEN' } }); expect(result.snapshot).toBeUndefined();
  });
  it('keeps cache on failed replacement and clears it on successful replacement/disconnect', async () => {
    const s = setup(); await s.connect(); await s.load();
    s.identify.mockRejectedValueOnce(new AuthFailure('INVALID_TOKEN')); await s.connect('failed-fixture');
    await s.load(); expect(s.fetcher).toHaveBeenCalledTimes(1);
    s.identify.mockResolvedValueOnce({ id: 43, login: 'another' }); await s.connect('new-fixture');
    expect(s.data[REVIEW_CACHE_KEY]).toMatchObject({ entries: [] });
    await s.load(); expect(s.fetcher).toHaveBeenCalledTimes(2);
    await s.auth.handle({ type: 'auth.disconnect' }, sender);
    expect(s.data[REVIEW_CACHE_KEY]).toBeUndefined();
  });
  it('marks a complete result uncached on write failure', async () => {
    const s = setup(); await s.connect(); s.storage.set.mockRejectedValueOnce(new Error(token));
    expect(await s.load()).toMatchObject({ complete: true, persistence: 'uncached', warning: { code: 'STORAGE' } });
  });
  it('returns large complete results uncached and rejects results over 8 MiB', async () => {
    const s = setup(); await s.connect();
    s.fetcher.mockResolvedValueOnce(response(page([thread('T1', [comment('C1', 'SUBMITTED', 'x'.repeat(4 * 1024 * 1024))])])));
    expect(await s.load()).toMatchObject({ complete: true, persistence: 'uncached' });
    s.fetcher.mockResolvedValueOnce(response(page([thread('T1', [comment('C1', 'SUBMITTED', 'x'.repeat(8 * 1024 * 1024))])])));
    expect(await s.load(true)).toMatchObject({ complete: false, error: { code: 'RESOURCE_LIMIT' } });
  });
});

describe('races, interruption, cooldowns', () => {
  it.each(['disconnect', 'replacement', 'invalid-recheck'])('rejects an in-flight reply after %s', async action => {
    const s = setup(); await s.connect(); const gate = deferred<Response>(); s.fetcher.mockReturnValueOnce(gate.promise);
    const pending = s.load(); await vi.waitFor(() => expect(s.fetcher).toHaveBeenCalledOnce());
    if (action === 'replacement') await s.connect('new-fixture');
    else if (action === 'invalid-recheck') { s.identify.mockRejectedValueOnce(new AuthFailure('INVALID_TOKEN')); await s.auth.handle({ type: 'auth.recheck' }, sender); }
    else await s.auth.handle({ type: 'auth.disconnect' }, sender);
    gate.resolve(response(page())); const reply = await pending;
    expect(reply.complete).toBe(false); expect(reply.snapshot).toBeUndefined(); expect(reply.partial).toBeUndefined();
  });
  it('does not invalidate a load on a failed replacement or successful recheck', async () => {
    const s = setup(); await s.connect(); const gate = deferred<Response>(); s.fetcher.mockReturnValueOnce(gate.promise);
    const pending = s.load(); await vi.waitFor(() => expect(s.fetcher).toHaveBeenCalledOnce());
    s.identify.mockRejectedValueOnce(new AuthFailure('INVALID_TOKEN')); await s.connect('failed-fixture');
    await s.auth.handle({ type: 'auth.recheck' }, sender);
    gate.resolve(response(page())); expect(await pending).toMatchObject({ complete: true });
  });
  it('cancels a pending request and rejects its late response', async () => {
    const s = setup(); await s.connect(); const gate = deferred<Response>(); s.fetcher.mockReturnValueOnce(gate.promise);
    const pending = s.load(); await vi.waitFor(() => expect(s.fetcher).toHaveBeenCalledOnce());
    await s.reviews.handle({ type: 'reviews.cancel' }, sender); gate.resolve(response(page()));
    expect(await pending).toMatchObject({ complete: false, error: { code: 'CANCELLED' } });
  });
  it('binds continuation to document, expires idle jobs, and restarts interrupted loads', async () => {
    const s = setup(); await s.connect(); s.fetcher.mockResolvedValueOnce(response(page([thread()], 'next')));
    const first = await s.load();
    expect(await continueLoad(s, first.jobId!, { ...sender, documentId: 'other' })).toMatchObject({ error: { code: 'INTERRUPTED' } });
    expect(await s.restart().reviews.handle({ type: 'reviews.continue', jobId: first.jobId }, sender)).toMatchObject({ error: { code: 'INTERRUPTED' } });
    s.advance(300_001); expect(await continueLoad(s, first.jobId!)).toMatchObject({ error: { code: 'INTERRUPTED' } });
    expect(await s.load()).toMatchObject({ complete: true });
  });
  it('allows no more than two concurrent GraphQL requests', async () => {
    const s = setup(); await s.connect(); const gate = deferred<Response>();
    s.fetcher.mockImplementation(() => gate.promise.then(r => r.clone()));
    const first = s.load(); const second = s.load(false, { ...sender, documentId: 'two' });
    await vi.waitFor(() => expect(s.fetcher).toHaveBeenCalledTimes(2));
    expect(await s.load(false, { ...sender, documentId: 'three' })).toMatchObject({ error: { code: 'BUSY' } });
    gate.resolve(response(page())); await Promise.all([first, second]);
  });
  it('persists GraphQL primary cooldown without blocking REST account verification', async () => {
    const s = setup(); await s.connect(); s.fetcher.mockResolvedValueOnce(response({ errors: [{ type: 'RATE_LIMITED', message: 'rate limit' }] }, 200,
      { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '100' }));
    expect(await s.load()).toMatchObject({ error: { code: 'RATE_LIMITED', retryAt: 100_000 } });
    expect(s.data[GRAPHQL_RETRY_KEY]).toEqual({ version: 1, retryAt: 100_000 });
    const restarted = s.restart();
    expect(await restarted.auth.handle({ type: 'auth.recheck' }, sender)).toMatchObject({ ok: true });
    expect(await restarted.reviews.handle({ type: 'reviews.load', pr: identity }, sender)).toMatchObject({ error: { code: 'RATE_LIMITED' } });
    expect(s.fetcher).toHaveBeenCalledTimes(1);
  });
  it('shares an explicit secondary cooldown with REST', async () => {
    const s = setup(); await s.connect(); s.fetcher.mockResolvedValueOnce(response({ message: 'secondary rate limit' }, 403, { 'retry-after': '60' }));
    await s.load(); expect(s.data[SECONDARY_RETRY_KEY]).toEqual({ version: 1, retryAt: 61_000 });
    expect(await s.auth.handle({ type: 'auth.recheck' }, sender)).toMatchObject({ error: { code: 'RATE_LIMITED', retryAt: 61_000 } });
  });
});

describe('authentication integration regressions', () => {
  it('suppresses review cache when the worker records confirmed invalid credentials', async () => {
    const s = setup(); await s.connect(); await s.load();
    // The same worker capability handles definitive invalid-token evidence from either API.
    const lease = await s.auth.credentials.acquire();
    await s.auth.credentials.reportFailure(lease, new AuthFailure('INVALID_TOKEN'));
    expect(await s.load()).toMatchObject({ error: { code: 'INVALID_TOKEN' } });
    expect(s.data[REVIEW_CACHE_KEY]).toMatchObject({ entries: [] });
  });
  it('shares REST secondary throttling with GraphQL across worker restart', async () => {
    const s = setup(); await s.connect();
    s.identify.mockRejectedValueOnce(new AuthFailure('RATE_LIMITED', 80_000, true));
    await s.auth.handle({ type: 'auth.recheck' }, sender);
    expect(await s.restart().reviews.handle({ type: 'reviews.load', pr: identity }, sender)).toMatchObject({ error: { code: 'RATE_LIMITED', retryAt: 80_000 } });
    expect(s.fetcher).not.toHaveBeenCalled();
  });
  it('does not resurrect cached data if a purge fails in storage', async () => {
    const s = setup(); await s.connect(); await s.load();
    s.fetcher.mockResolvedValueOnce(response({}, 404));
    s.storage.set.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('quota'));
    expect((await s.load(true)).snapshot).toBeUndefined();
    s.fetcher.mockRejectedValueOnce(new Error('offline'));
    expect((await s.load()).snapshot).toBeUndefined();
  });
});

it('keeps a successful final-budget page and blocks further requests until reset', async () => {
  const s = setup(); await s.connect();
  s.fetcher.mockResolvedValueOnce(response(page(), 200, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '90' }));
  expect(await s.load()).toMatchObject({ complete: true });
  expect(await s.load()).toMatchObject({ complete: true, persistence: 'cached' });
  expect(await s.load(true)).toMatchObject({ complete: false, error: { code: 'RATE_LIMITED', retryAt: 90_000 } });
  expect(s.fetcher).toHaveBeenCalledTimes(1);
});
