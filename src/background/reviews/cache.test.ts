import { describe, expect, it } from 'vitest';
import { createReviewCache, bytes, CACHE_BYTES } from './cache';
import { REVIEW_CACHE_KEY } from './keys';
import { setup } from './fixtures.test-support';
import type { ReviewSnapshot } from '../../shared/reviews';

function snapshot(number: number, fetchedAt = 1000): ReviewSnapshot {
  return { complete: true, fetchedAt, identity: { owner: 'octocat', repo: 'hello-world', number },
    data: { pr: { id: `PR${number}`, number, title: 'title', url: `https://github.com/octocat/hello-world/pull/${number}`, state: 'OPEN', isDraft: false }, threads: [] } };
}
describe('bounded cache', () => {
  it('evicts the least recently used entry at 20 entries', async () => {
    const s = setup(); await s.connect(); const lease = await s.auth.credentials.acquire();
    let time = 0; const cache = createReviewCache(s.storage, () => ++time);
    for (let i = 1; i <= 20; i++) await cache.put(lease, snapshot(i));
    await cache.get(lease, snapshot(1).identity);
    await cache.put(lease, snapshot(21));
    expect(await cache.get(lease, snapshot(2).identity)).toBeUndefined();
    expect(await cache.get(lease, snapshot(1).identity)).toBeDefined();
  });
  it('enforces the byte cap and isolates accounts and credential revisions', async () => {
    const s = setup(); await s.connect(); const lease = await s.auth.credentials.acquire();
    const cache = createReviewCache(s.storage);
    for (let i = 1; i <= 3; i++) {
      const value = snapshot(i); value.data.pr.title = 'x'.repeat(1_500_000); await cache.put(lease, value);
    }
    expect(bytes(s.data[REVIEW_CACHE_KEY])).toBeLessThanOrEqual(CACHE_BYTES);
    expect(await cache.get(lease, snapshot(1).identity)).toBeUndefined();
    expect(await cache.get({ ...lease, accountId: 999 }, snapshot(3).identity)).toBeUndefined();
    expect(await cache.get({ ...lease, revision: crypto.randomUUID() }, snapshot(3).identity)).toBeUndefined();
  });
  it('ignores corrupt cache records and reports storage read failures', async () => {
    const s = setup(); await s.connect(); const lease = await s.auth.credentials.acquire(); const cache = createReviewCache(s.storage);
    s.data[REVIEW_CACHE_KEY] = { version: 1, entries: [{ token: 'never-return-this' }] };
    expect(await cache.get(lease, snapshot(1).identity)).toBeUndefined();
    s.storage.get.mockRejectedValueOnce(new Error('raw'));
    await expect(cache.get(lease, snapshot(1).identity)).rejects.toMatchObject({ code: 'STORAGE' });
  });
});
