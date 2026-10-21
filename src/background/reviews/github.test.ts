import { afterEach, describe, expect, it, vi } from 'vitest';
import { createReviewApi } from './github';
import { identity, page, response, token } from './fixtures.test-support';

afterEach(() => vi.useRealTimers());
describe('GraphQL transport', () => {
  it('uses fixed queries, omits cookies, rejects redirects, and separates comment pagination', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response(page())).mockResolvedValueOnce(response({ data: { node: { id: 'T1', comments: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } }));
    const api = createReviewApi(fetcher);
    const signal = new AbortController().signal;
    await api.threads(token, identity, null, signal); await api.comments(token, 'T1', 'cursor', signal);
    const [url, options] = fetcher.mock.calls[0]!;
    expect(url).toBe('https://api.github.com/graphql');
    expect(options).toMatchObject({ method: 'POST', credentials: 'omit', redirect: 'error', cache: 'no-store', headers: { Authorization: `Bearer ${token}` } });
    const body = JSON.parse(options!.body as string);
    expect(body.query).toContain('reviewThreads(first: 25'); expect(body.query).toContain('comments(first: 20');
    expect(body.variables).toEqual({ ...identity, cursor: null });
    const nested = JSON.parse(fetcher.mock.calls[1]![1]!.body as string);
    expect(nested.query).toContain('comments(first: 100'); expect(nested.variables).toEqual({ id: 'T1', cursor: 'cursor' });
  });
  it.each([[401, 'INVALID_TOKEN'], [403, 'FORBIDDEN'], [404, 'REPOSITORY_UNAVAILABLE'], [429, 'RATE_LIMITED'], [500, 'UNEXPECTED_RESPONSE']] as const)(
    'classifies HTTP %s even without JSON', async (status, code) => {
      const api = createReviewApi(vi.fn<typeof fetch>().mockResolvedValue(new Response('not JSON', { status })));
      await expect(api.threads(token, identity, null, new AbortController().signal)).rejects.toMatchObject({ code });
    });
  it.each([
    [{ data: { repository: null } }, 'REPOSITORY_UNAVAILABLE'],
    [{ data: { repository: { pullRequest: null } } }, 'REPOSITORY_UNAVAILABLE'],
    [{ data: { repository: { pullRequest: {} } } }, 'UNEXPECTED_RESPONSE'],
    [{ ...page(), errors: [{ type: 'FORBIDDEN', message: token }] }, 'FORBIDDEN'],
    [{ ...page(), errors: [{ type: 'NOT_FOUND', message: token }] }, 'REPOSITORY_UNAVAILABLE'],
    [{ ...page(), errors: [{ message: token }] }, 'INCOMPLETE'],
  ])('validates error envelopes and null data %#', async (body, code) => {
    const api = createReviewApi(vi.fn<typeof fetch>().mockResolvedValue(response(body)));
    await expect(api.threads(token, identity, null, new AbortController().signal)).rejects.toMatchObject({ code });
  });
  it('handles malformed JSON and network errors without exposing raw details', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('broken')).mockRejectedValueOnce(new Error(token));
    const api = createReviewApi(fetcher);
    await expect(api.threads(token, identity, null, new AbortController().signal)).rejects.toThrow('UNEXPECTED_RESPONSE');
    await expect(api.threads(token, identity, null, new AbortController().signal)).rejects.toThrow('NETWORK');
  });
  it('times out at 15 seconds and aborts the request', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>().mockImplementation((_url, options) => new Promise((_resolve, reject) => {
      options!.signal!.addEventListener('abort', () => reject(new Error(token)));
    }));
    const promise = createReviewApi(fetcher).threads(token, identity, null, new AbortController().signal);
    const assertion = expect(promise).rejects.toMatchObject({ code: 'TIMEOUT' });
    await vi.advanceTimersByTimeAsync(15_000); await assertion;
    expect(fetcher.mock.calls[0]![1]!.signal!.aborted).toBe(true);
  });
  it('honors retry-after and primary reset guidance without retrying', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ errors: [{ type: 'RATE_LIMITED' }] }, 200,
      { 'retry-after': '120', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '200' }));
    await expect(createReviewApi(fetcher, () => 1_000).threads(token, identity, null, new AbortController().signal))
      .rejects.toMatchObject({ code: 'RATE_LIMITED', retryAt: 200_000 });
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
