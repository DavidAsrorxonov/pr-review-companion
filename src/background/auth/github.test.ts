import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAuthApi } from './github';

const token = 'github_pat_fixture_DO_NOT_USE';
const json = (data: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(data), { status, headers });
afterEach(() => vi.useRealTimers());

describe('GitHub authentication HTTP boundary', () => {
  it('uses a fixed origin, omits cookies and redirects, and strips extra identity fields', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({ id: 42, login: 'octocat', email: 'private@example.com' }));
    const api = createAuthApi(fetcher);
    expect(await api.identify(token)).toEqual({ id: 42, login: 'octocat' });
    expect(fetcher).toHaveBeenCalledWith('https://api.github.com/user', expect.objectContaining({
      method: 'GET', credentials: 'omit', redirect: 'error', cache: 'no-store',
      headers: expect.objectContaining({ Authorization: `Bearer ${token}` }),
      signal: expect.any(AbortSignal),
    }));
  });

  it.each([{ body: [] }, { body: [{ id: 1, number: 3, body: 'Discard me' }] }])('accepts accessible repository results without returning PR data', async ({ body }) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(body));
    const api = createAuthApi(fetcher);
    expect(await api.checkRepository(token, 'owner', 'repo.name')).toBeUndefined();
    expect(fetcher).toHaveBeenCalledWith('https://api.github.com/repos/owner/repo.name/pulls?state=all&per_page=1', expect.any(Object));
  });

  it.each([
    [401, 'INVALID_TOKEN'], [403, 'FORBIDDEN'], [404, 'REPOSITORY_UNAVAILABLE'],
    [429, 'RATE_LIMITED'], [500, 'UNEXPECTED_RESPONSE'],
  ])('sanitizes HTTP %i for both identity and repository checks', async (status, code) => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => json({ message: `sensitive ${token}` }, Number(status)));
    const api = createAuthApi(fetcher, () => 1000);
    for (const check of [() => api.identify(token), () => api.checkRepository(token, 'owner', 'repo')]) {
      try { await check(); expect.fail('Expected an error'); } catch (error) {
        expect(error).toMatchObject({ code });
        expect(String(error)).not.toContain(token);
        expect(JSON.stringify(error)).not.toContain(token);
      }
    }
  });

  it.each([
    ['primary', { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '120' }, 'API rate limit exceeded', 120_000],
    ['secondary', { 'retry-after': '120' }, 'Secondary rate limit', 121_000],
    ['date', { 'retry-after': 'Thu, 01 Jan 1970 00:02:00 GMT' }, 'Secondary rate limit', 120_000],
    ['fallback', {}, 'Secondary rate limit', 61_000],
  ])('honors %s rate-limit guidance', async (_label, headers, message, expected) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({ message }, 403, headers as Record<string, string>));
    await expect(createAuthApi(fetcher, () => 1000).identify(token)).rejects.toMatchObject({ code: 'RATE_LIMITED', retryAt: expected });
  });

  it('rejects malformed JSON and unexpected schemas', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const api = createAuthApi(fetcher);
    fetcher.mockResolvedValueOnce(new Response('not json'));
    await expect(api.identify(token)).rejects.toMatchObject({ code: 'UNEXPECTED_RESPONSE' });
    fetcher.mockResolvedValueOnce(json({ login: 'missing-id' }));
    await expect(api.identify(token)).rejects.toMatchObject({ code: 'UNEXPECTED_RESPONSE' });
    fetcher.mockResolvedValueOnce(json({ items: [] }));
    await expect(api.checkRepository(token, 'owner', 'repo')).rejects.toMatchObject({ code: 'UNEXPECTED_RESPONSE' });
    fetcher.mockResolvedValueOnce(new Response('not json'));
    await expect(api.checkRepository(token, 'owner', 'repo')).rejects.toMatchObject({ code: 'UNEXPECTED_RESPONSE' });
  });

  it('redacts network errors without retries', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error(token));
    const api = createAuthApi(fetcher);
    await expect(api.identify(token)).rejects.toMatchObject({ code: 'NETWORK', message: 'NETWORK' });
    await expect(api.checkRepository(token, 'owner', 'repo')).rejects.toMatchObject({ code: 'NETWORK' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each(['identity', 'repository'])('aborts a stalled %s request after 15 seconds', async method => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>().mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(new Error('Aborted')));
    }));
    const api = createAuthApi(fetcher);
    const pending = method === 'identity' ? api.identify(token) : api.checkRepository(token, 'owner', 'repo');
    const assertion = expect(pending).rejects.toMatchObject({ code: 'TIMEOUT' });
    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
