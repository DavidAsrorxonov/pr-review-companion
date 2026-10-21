import { z } from 'zod';
import { snapshotSchema } from '../../shared/reviews';
import type { PrIdentity, ReviewSnapshot } from '../../shared/reviews';
import type { AuthStorage, CredentialLease } from '../auth/controller';
import { AuthFailure } from '../auth/errors';
import { REVIEW_CACHE_KEY } from './keys';

export const CACHE_TTL = 60_000;
export const CACHE_BYTES = 4 * 1024 * 1024;
export const MAX_RESULT_BYTES = 8 * 1024 * 1024;
export const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
const entrySchema = z.object({ accountId: z.number().int().positive(), revision: z.string().uuid(),
  usedAt: z.number().finite().nonnegative(), snapshot: snapshotSchema }).strict();
const cacheSchema = z.object({ version: z.literal(1), entries: z.array(entrySchema).max(20) }).strict();
type Entry = z.infer<typeof entrySchema>;
export const prKey = (pr: PrIdentity) => `${pr.owner.toLowerCase()}/${pr.repo.toLowerCase()}#${pr.number}`;

// Called under the credential controller's commit lock, including cache reads.
export function createReviewCache(storage: AuthStorage, now = Date.now) {
  async function read(lease: CredentialLease): Promise<Entry[]> {
    let raw: unknown;
    try { raw = (await storage.get([REVIEW_CACHE_KEY]))[REVIEW_CACHE_KEY]; }
    catch { throw new AuthFailure('STORAGE'); }
    if (raw === undefined) return [];
    const parsed = bytes(raw) <= CACHE_BYTES ? cacheSchema.safeParse(raw) : null;
    if (!parsed?.success) return []; // Disposable cache; malformed data never becomes a snapshot.
    return parsed.data.entries.filter(e => e.accountId === lease.accountId && e.revision === lease.revision);
  }
  async function write(entries: Entry[]) {
    try { await storage.set({ [REVIEW_CACHE_KEY]: { version: 1, entries } }); }
    catch { throw new AuthFailure('STORAGE'); }
  }
  return {
    async get(lease: CredentialLease, pr: PrIdentity) {
      const entries = await read(lease);
      const found = entries.find(e => prKey(e.snapshot.identity) === prKey(pr));
      if (!found) return undefined;
      found.usedAt = now();
      // An LRU touch is best-effort; the previously persisted snapshot remains valid.
      try { await write([...entries.filter(entry => entry !== found), found]); } catch { /* No claim of a new persistence operation. */ }
      return found.snapshot;
    },
    async put(lease: CredentialLease, snapshot: ReviewSnapshot): Promise<boolean> {
      const entry = { accountId: lease.accountId, revision: lease.revision, usedAt: now(), snapshot };
      if (bytes({ version: 1, entries: [entry] }) > CACHE_BYTES) return false;
      const entries = (await read(lease)).filter(e => prKey(e.snapshot.identity) !== prKey(snapshot.identity));
      entries.push(entry);
      entries.sort((a, b) => a.usedAt - b.usedAt);
      while (entries.length > 20 || bytes({ version: 1, entries }) > CACHE_BYTES) entries.shift();
      await write(entries);
      return true;
    },
    async purge(lease: CredentialLease, pr: PrIdentity) {
      await write((await read(lease)).filter(e => prKey(e.snapshot.identity) !== prKey(pr)));
    },
  };
}
