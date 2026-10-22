import { parsePrUrl, counts, metadataSchema, reviewFailure, reviewRequestSchema } from '../../shared/reviews';
import type { PrIdentity, ReviewData, ReviewReply, ReviewSnapshot, ReviewThread } from '../../shared/reviews';
import type { AuthStorage, CredentialAccess, CredentialLease } from '../auth/controller';
import { AuthFailure } from '../auth/errors';
import { bytes, CACHE_TTL, createReviewCache, MAX_RESULT_BYTES, prKey } from './cache';
import { ReviewFailure, safeReviewError } from './errors';
import type { CommentPage, ReviewApi } from './github';

import { checkCurrentPr, identifyCaller, samePr } from '../panel/access';
import type { Caller, GetTab, PageSender } from '../panel/access';
type Cursor = { next: string | null; done: boolean; seen: string[] };
type Job = {
  id: string; caller: string; source: Caller; pr: PrIdentity; lease: CredentialLease; touched: number;
  controller: AbortController; busy: boolean; pages: number; data?: ReviewData;
  threads: Cursor; comments: Record<string, Cursor>; previous?: ReviewSnapshot;
};
const newCursor = (): Cursor => ({ next: null, done: false, seen: [] });
function advance(cursor: Cursor, page: CommentPage['pageInfo']): Cursor {
  if (!page.hasNextPage) return { ...cursor, done: true, next: null };
  if (!page.endCursor || cursor.seen.includes(page.endCursor)) throw new ReviewFailure('INCOMPLETE');
  return { next: page.endCursor, done: false, seen: [...cursor.seen, page.endCursor] };
}
function mergeComments(thread: ReviewThread, page: CommentPage) {
  const seen = new Set(thread.comments.map(c => c.id));
  for (const { state, ...comment } of page.nodes) {
    if (state === 'SUBMITTED' && !seen.has(comment.id)) { thread.comments.push(comment); seen.add(comment.id); }
  }
}
export function createReviewController(deps: {
  credentials: CredentialAccess; storage: AuthStorage; api: ReviewApi; extensionId: string; getTab?: GetTab; now?: () => number;
}) {
  const { credentials, api, extensionId } = deps;
  const now = deps.now ?? Date.now;
  const cache = createReviewCache(deps.storage, now);
  const jobs = new Map<string, Job>();
  const denied = new Set<string>();
  const accessKey = (lease: CredentialLease, pr: PrIdentity) => `${lease.revision}:${prKey(pr)}`;
  let activeRequests = 0;
  function stop(job: Job) { job.controller.abort(); if (jobs.get(job.caller) === job) jobs.delete(job.caller); }
  credentials.onChange(() => { for (const job of jobs.values()) stop(job); denied.clear(); });
  function current(job: Job) {
    if (jobs.get(job.caller) !== job || job.controller.signal.aborted) throw new ReviewFailure('CANCELLED');
    if (now() - job.touched > 300_000) { stop(job); throw new ReviewFailure('INTERRUPTED'); }
  }
  function progress(job: Job): ReviewReply {
    const total = job.data ? counts(job.data) : { total: 0, comments: 0 };
    return { ok: true, state: 'loading', complete: false, identity: job.pr, revision: job.lease.revision, jobId: job.id,
      ...(job.data ? { partial: job.data } : {}),
      ...(job.previous ? { snapshot: job.previous } : {}),
      progress: { pages: job.pages, threads: total.total, comments: total.comments },
      freshness: job.previous ? 'stale' : 'none', persistence: job.previous ? 'cached' : 'none' };
  }
  async function step(job: Job): Promise<ReviewReply> {
    try {
      await credentials.run(job.lease, () => {
        current(job);
        if (job.busy || activeRequests >= 2) throw new ReviewFailure('BUSY');
        job.busy = true; job.touched = now(); activeRequests++;
      });
    } catch (error) { return { ...reviewFailure(safeReviewError(error).code), error: safeReviewError(error) }; }
    try {
      await checkCurrentPr(job.source, job.pr, deps.getTab);
      await credentials.checkRequest(job.lease);
      current(job);
      const pending = Object.entries(job.comments).find(([, cursor]) => !cursor.done);
      const page = pending
        ? await api.comments(job.lease.token, pending[0], pending[1].next!, job.controller.signal)
        : await api.threads(job.lease.token, job.pr, job.threads.next, job.controller.signal);
      // A successful last-budget page remains usable; the next request must wait.
      if (page.retryAt !== undefined) await credentials.reportFailure(job.lease, new AuthFailure('RATE_LIMITED', page.retryAt));
      return await credentials.run(job.lease, async () => {
        current(job);
        await checkCurrentPr(job.source, job.pr, deps.getTab);
        current(job);
        // Validate/assemble a whole page before advancing any checkpoint.
        const data = job.data ? structuredClone(job.data) : undefined;
        const comments = structuredClone(job.comments);
        let threads = structuredClone(job.threads);
        let nextData: ReviewData;
        if ('reviewThreads' in page) {
          if (page.number !== job.pr.number || (data && page.id !== data.pr.id)) throw new ReviewFailure('INCOMPLETE');
          threads = advance(threads, page.reviewThreads.pageInfo);
          nextData = data ?? { pr: metadataSchema.parse({ id: page.id, number: page.number, title: page.title,
            url: page.url, state: page.state, isDraft: page.isDraft }), threads: [] };
          for (const { comments: connection, ...fields } of page.reviewThreads.nodes) {
            if (nextData.threads.some(thread => thread.id === fields.id)) continue;
            const thread = { ...fields, comments: [] };
            mergeComments(thread, connection);
            nextData.threads.push(thread);
            comments[fields.id] = advance(newCursor(), connection.pageInfo);
          }
        } else {
          if (!data || !pending) throw new ReviewFailure('INCOMPLETE');
          const thread = data.threads.find(thread => thread.id === pending[0]);
          if (!thread) throw new ReviewFailure('INCOMPLETE');
          comments[pending[0]] = advance(pending[1], page.pageInfo);
          mergeComments(thread, page);
          nextData = data;
        }
        if (bytes({ data: nextData, threads, comments }) > MAX_RESULT_BYTES) throw new ReviewFailure('RESOURCE_LIMIT');
        denied.delete(accessKey(job.lease, job.pr));
        job.data = nextData; job.threads = threads; job.comments = comments; job.pages++; job.touched = now();
        if (!threads.done || Object.values(comments).some(cursor => !cursor.done)) return progress(job);
        const snapshot: ReviewSnapshot = { identity: job.pr, data: nextData, complete: true, fetchedAt: now() };
        let cached = false;
        let warning: ReviewReply['warning'];
        try { cached = await cache.put(job.lease, snapshot); }
        catch { warning = { code: 'STORAGE' }; }
        stop(job);
        return { ok: true, state: 'complete', complete: true, identity: job.pr, revision: job.lease.revision,
          snapshot, progress: { pages: job.pages, threads: counts(nextData).total, comments: counts(nextData).comments },
          freshness: 'fresh', persistence: cached ? 'cached' : 'uncached', ...(warning ? { warning } : {}) };
      });
    } catch (error) {
      let safe = safeReviewError(error);
      try {
        if (safe.code === 'INVALID_TOKEN') {
          await credentials.reportFailure(job.lease, error);
          stop(job);
          return reviewFailure('INVALID_TOKEN');
        }
        await credentials.reportFailure(job.lease, error);
        return await credentials.run(job.lease, async () => {
          current(job);
          await checkCurrentPr(job.source, job.pr, deps.getTab);
          if (safe.code === 'FORBIDDEN' || safe.code === 'REPOSITORY_UNAVAILABLE') {
            denied.add(accessKey(job.lease, job.pr));
            for (const other of jobs.values()) {
              if (other !== job && accessKey(other.lease, other.pr) === accessKey(job.lease, job.pr)) stop(other);
            }
            job.previous = undefined; job.data = undefined;
            await cache.purge(job.lease, job.pr);
          }
          const reply = progress(job);
          stop(job);
          return { ...reply, ok: false, state: 'error', error: safe, jobId: undefined };
        });
      } catch (failure) { safe = safeReviewError(failure); }
      stop(job);
      return { ...reviewFailure(safe.code), error: safe };
    } finally { job.busy = false; activeRequests--; }
  }
  async function handle(raw: unknown, sender: PageSender): Promise<ReviewReply> {
    try {
      const source = identifyCaller(sender, extensionId);
      const request = reviewRequestSchema.safeParse(raw);
      if (!request.success) throw new AuthFailure('INVALID_REQUEST');
      const lease = await credentials.acquire();
      const caller = source.key;
      let requestedPr: PrIdentity | undefined;
      const selected = await credentials.run(lease, async (): Promise<Job | ReviewReply> => {
        for (const job of jobs.values()) if (!job.busy && now() - job.touched > 300_000) stop(job);
        const existing = jobs.get(caller);
        if (request.data.type === 'reviews.cancel') {
          if (existing && (!request.data.jobId || existing.id === request.data.jobId)) stop(existing);
          return { ok: true, state: 'cancelled', complete: false, freshness: 'none', persistence: 'none', revision: lease.revision };
        }
        if (request.data.type === 'reviews.continue') {
          if (!existing || existing.id !== request.data.jobId) throw new ReviewFailure('INTERRUPTED');
          requestedPr = existing.pr;
          await checkCurrentPr(source, existing.pr, deps.getTab);
          return existing;
        }
        if (existing) stop(existing);
        const pr = request.data.pr;
        requestedPr = pr;
        await checkCurrentPr(source, pr, deps.getTab);
        const previous = denied.has(accessKey(lease, pr)) ? undefined : await cache.get(lease, pr);
        if (previous && !request.data.refresh && now() >= previous.fetchedAt && now() - previous.fetchedAt < CACHE_TTL) {
          return { ok: true, state: 'complete', complete: true, identity: pr, revision: lease.revision,
            snapshot: previous, freshness: 'fresh', persistence: 'cached' };
        }
        const job: Job = { id: crypto.randomUUID(), caller, source, pr, lease, previous, touched: now(),
          controller: new AbortController(), busy: false, pages: 0, threads: newCursor(), comments: Object.create(null) as Record<string, Cursor> };
        jobs.set(caller, job);
        return job;
      });
      const reply = 'caller' in selected ? await step(selected) : selected;
      if (requestedPr) await checkCurrentPr(source, requestedPr, deps.getTab);
      if (reply.snapshot || reply.partial) return await credentials.run(lease, () => reply);
      return reply;
    } catch (error) {
      const safe = safeReviewError(error);
      return { ...reviewFailure(safe.code), error: safe };
    }
  }
  return { handle,
    tabChanged(tabId: number, url?: string) {
      for (const job of jobs.values()) {
        if (job.source.tabId === tabId && (!url || !samePr(parsePrUrl(url), job.pr))) stop(job);
      }
    },
  };
}
