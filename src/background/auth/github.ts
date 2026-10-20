import { z } from 'zod';
import { AuthFailure } from './errors';

const identitySchema = z.object({ id: z.number().int().positive(), login: z.string().min(1).max(100) });
const pullsSchema = z.array(z.object({ id: z.number().int().positive(), number: z.number().int().positive() }));

export interface AuthApi {
  identify(token: string): Promise<{ id: number; login: string }>;
  checkRepository(token: string, owner: string, repo: string): Promise<void>;
}

function retryTime(response: Response, now: number): number {
  const retryAfter = response.headers.get('retry-after');
  const reset = response.headers.get('x-ratelimit-remaining') === '0'
    ? Number(response.headers.get('x-ratelimit-reset')) * 1000 : 0;
  const after = retryAfter === null ? 0 : /^\d+$/.test(retryAfter)
    ? now + Number(retryAfter) * 1000 : Date.parse(retryAfter);
  const candidates = [reset, after].filter(value => Number.isFinite(value) && value > now);
  return candidates.length ? Math.max(...candidates) : now + 60_000;
}

export function createAuthApi(fetcher: typeof fetch = fetch, now = Date.now): AuthApi {
  async function get(token: string, endpoint: string): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetcher(`https://api.github.com${endpoint}`, {
        method: 'GET', credentials: 'omit', redirect: 'error', cache: 'no-store',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2026-03-10',
        },
        signal: controller.signal,
      });
      let data: unknown;
      try { data = await response.json(); } catch { /* Classify HTTP errors even with an invalid body. */ }
      const errorBody = z.object({ message: z.string() }).safeParse(data);
      const limited = response.status === 429 || (response.status === 403 && (
        response.headers.get('x-ratelimit-remaining') === '0' || response.headers.has('retry-after')
        || (errorBody.success && /rate limit/i.test(errorBody.data.message))
      ));
      if (limited) throw new AuthFailure('RATE_LIMITED', retryTime(response, now()));
      if (response.status === 401) throw new AuthFailure('INVALID_TOKEN');
      if (response.status === 403) throw new AuthFailure('FORBIDDEN');
      if (response.status === 404) throw new AuthFailure('REPOSITORY_UNAVAILABLE');
      if (!response.ok || data === undefined) throw new AuthFailure('UNEXPECTED_RESPONSE');
      return data;
    } catch (error) {
      if (controller.signal.aborted) throw new AuthFailure('TIMEOUT');
      if (error instanceof AuthFailure) throw error;
      throw new AuthFailure('NETWORK');
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    async identify(token) {
      const parsed = identitySchema.safeParse(await get(token, '/user'));
      if (!parsed.success) throw new AuthFailure('UNEXPECTED_RESPONSE');
      return parsed.data;
    },
    async checkRepository(token, owner, repo) {
      const parsed = pullsSchema.safeParse(await get(token,
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls?state=all&per_page=1`));
      if (!parsed.success) throw new AuthFailure('UNEXPECTED_RESPONSE');
    },
  };
}
