import { z } from 'zod';
import { commentSchema, metadataSchema, threadSchema } from '../../shared/reviews';
import type { PrIdentity } from '../../shared/reviews';
import { AuthFailure } from '../auth/errors';
import { retryTime } from '../auth/github';
import { ReviewFailure } from './errors';

export const pageInfoSchema = z.object({ hasNextPage: z.boolean(), endCursor: z.string().min(1).nullable() });
const rawComment = commentSchema.extend({ state: z.enum(['PENDING', 'SUBMITTED']) }).strip();
const commentsSchema = z.object({ nodes: z.array(rawComment), pageInfo: pageInfoSchema });
const rawThread = threadSchema.omit({ comments: true }).extend({ comments: commentsSchema }).strip();
const threadsSchema = z.object({ nodes: z.array(rawThread), pageInfo: pageInfoSchema });
const prSchema = metadataSchema.extend({ reviewThreads: threadsSchema }).strip();
const threadsResponse = z.object({ repository: z.object({ pullRequest: prSchema.nullable() }).nullable() });
const commentsResponse = z.object({ node: z.object({ id: z.string(), comments: commentsSchema }).nullable() });
export type ThreadPage = z.infer<typeof prSchema> & { retryAt?: number };
export type CommentPage = z.infer<typeof commentsSchema> & { retryAt?: number };
export interface ReviewApi {
  threads(token: string, pr: PrIdentity, cursor: string | null, signal: AbortSignal): Promise<ThreadPage>;
  comments(token: string, threadId: string, cursor: string, signal: AbortSignal): Promise<CommentPage>;
}
const commentFields = 'id url body author { login } createdAt updatedAt state';
const pageFields = 'pageInfo { hasNextPage endCursor }';
const threadQuery = `query ReviewThreads($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $repo) { pullRequest(number: $number) {
    id number title url state isDraft
    reviewThreads(first: 25, after: $cursor) { ${pageFields} nodes {
      id isResolved isOutdated path line originalLine startLine originalStartLine diffSide startDiffSide
      comments(first: 20) { ${pageFields} nodes { ${commentFields} } }
    } }
  } }
}`;
const commentQuery = `query ReviewComments($id: ID!, $cursor: String!) {
  node(id: $id) { ... on PullRequestReviewThread { id
    comments(first: 100, after: $cursor) { ${pageFields} nodes { ${commentFields} } }
  } }
}`;
export function createReviewApi(fetcher: typeof fetch = fetch, now = Date.now): ReviewApi {
  async function query(token: string, query: string, variables: object, signal: AbortSignal): Promise<{ data: unknown; retryAt?: number }> {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 15_000);
    try {
      const response = await fetcher('https://api.github.com/graphql', {
        method: 'POST', credentials: 'omit', redirect: 'error', cache: 'no-store', signal: controller.signal,
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables }),
      });
      let body: unknown;
      try { body = await response.json(); } catch { /* HTTP classification still applies. */ }
      const envelope = z.object({ data: z.unknown().optional(), message: z.string().optional(),
        errors: z.array(z.object({ type: z.string().optional(), message: z.string().optional(), extensions: z.object({ code: z.string().optional() }).optional() })).optional(),
      }).safeParse(body);
      const errors = envelope.success ? envelope.data.errors ?? [] : [];
      const messages = [envelope.success ? envelope.data.message ?? '' : '', ...errors.map(e => e.message ?? '')].join(' ');
      const secondary = /secondary rate|abuse/i.test(messages);
      const limited = response.status === 429 || errors.some(e => e.type === 'RATE_LIMITED' || e.extensions?.code === 'RATE_LIMITED')
        || ((response.status === 403 || errors.length > 0) && (response.headers.get('x-ratelimit-remaining') === '0'
          || response.headers.has('retry-after') || /rate limit|abuse/i.test(messages)));
      if (limited) throw new AuthFailure('RATE_LIMITED', retryTime(response, now()), secondary);
      if (response.status === 401 || errors.some(e => e.type === 'UNAUTHORIZED')) throw new AuthFailure('INVALID_TOKEN');
      if (response.status === 403 || errors.some(e => e.type === 'FORBIDDEN')) throw new AuthFailure('FORBIDDEN');
      if (response.status === 404 || errors.some(e => e.type === 'NOT_FOUND')) throw new AuthFailure('REPOSITORY_UNAVAILABLE');
      if (!response.ok || !envelope.success || envelope.data.data === undefined) throw new AuthFailure('UNEXPECTED_RESPONSE');
      if (errors.length) throw new ReviewFailure('INCOMPLETE');
      return { data: envelope.data.data, ...(response.headers.get('x-ratelimit-remaining') === '0'
        ? { retryAt: retryTime(response, now()) } : {}) };
    } catch (error) {
      if (signal.aborted) throw new ReviewFailure('CANCELLED');
      if (timedOut) throw new AuthFailure('TIMEOUT');
      if (error instanceof AuthFailure || error instanceof ReviewFailure) throw error;
      throw new AuthFailure('NETWORK');
    } finally { clearTimeout(timer); signal.removeEventListener('abort', cancel); }
  }
  return {
    async threads(token, pr, cursor, signal) {
      const result = await query(token, threadQuery, { ...pr, cursor }, signal);
      const parsed = threadsResponse.safeParse(result.data);
      if (!parsed.success) throw new AuthFailure('UNEXPECTED_RESPONSE');
      if (!parsed.data.repository?.pullRequest) throw new AuthFailure('REPOSITORY_UNAVAILABLE');
      return { ...parsed.data.repository.pullRequest, ...(result.retryAt ? { retryAt: result.retryAt } : {}) };
    },
    async comments(token, threadId, cursor, signal) {
      const result = await query(token, commentQuery, { id: threadId, cursor }, signal);
      const parsed = commentsResponse.safeParse(result.data);
      if (!parsed.success) throw new AuthFailure('UNEXPECTED_RESPONSE');
      if (!parsed.data.node) throw new ReviewFailure('INCOMPLETE');
      if (parsed.data.node.id !== threadId) throw new AuthFailure('UNEXPECTED_RESPONSE');
      return { ...parsed.data.node.comments, ...(result.retryAt ? { retryAt: result.retryAt } : {}) };
    },
  };
}
