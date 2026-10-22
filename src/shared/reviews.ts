import { z } from 'zod';
import { errorCodeSchema, ownerSchema, repoSchema } from './auth';

const timestamp = z.number().finite().nonnegative();
const id = z.string().min(1);
const githubUrl = z.string().url().refine(value => {
  const url = new URL(value);
  return url.protocol === 'https:' && url.hostname === 'github.com' && !url.port && !url.username && !url.password;
});
export const prIdentitySchema = z.object({
  owner: ownerSchema.transform(value => value.toLowerCase()),
  repo: repoSchema.transform(value => value.toLowerCase()),
  number: z.number().int().positive().max(2_147_483_647),
}).strict();
export type PrIdentity = z.infer<typeof prIdentitySchema>;
export { parsePrUrl } from './prUrl';
export const metadataSchema = z.object({
  id, number: z.number().int().positive(), title: z.string(), url: githubUrl,
  state: z.enum(['OPEN', 'CLOSED', 'MERGED']), isDraft: z.boolean(),
}).strict();
export const commentSchema = z.object({
  id, url: githubUrl, body: z.string(), author: z.object({ login: id }).strict().nullable(),
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
}).strict();
const line = z.number().int().positive().nullable();
export const threadSchema = z.object({
  id, isResolved: z.boolean(), isOutdated: z.boolean(), path: z.string(),
  line, originalLine: line, startLine: line, originalStartLine: line,
  diffSide: z.enum(['LEFT', 'RIGHT']), startDiffSide: z.enum(['LEFT', 'RIGHT']).nullable(),
  comments: z.array(commentSchema),
}).strict();
export const reviewDataSchema = z.object({ pr: metadataSchema, threads: z.array(threadSchema) }).strict();
export type ReviewData = z.infer<typeof reviewDataSchema>;
export type ReviewThread = z.infer<typeof threadSchema>;
export const snapshotSchema = z.object({
  identity: prIdentitySchema, data: reviewDataSchema, complete: z.literal(true), fetchedAt: timestamp,
}).strict();
export type ReviewSnapshot = z.infer<typeof snapshotSchema>;
export const reviewErrorCodeSchema = z.enum([
  ...errorCodeSchema.options, 'INTERRUPTED', 'CANCELLED', 'RESOURCE_LIMIT', 'INCOMPLETE', 'BUSY',
]);
export type ReviewErrorCode = z.infer<typeof reviewErrorCodeSchema>;
export const reviewErrorSchema = z.object({ code: reviewErrorCodeSchema, retryAt: timestamp.optional() }).strict();
export type ReviewError = z.infer<typeof reviewErrorSchema>;
export const reviewRequestSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('reviews.load'), pr: prIdentitySchema, refresh: z.boolean().optional() }).strict(),
  z.object({ type: z.literal('reviews.continue'), jobId: z.string().uuid() }).strict(),
  z.object({ type: z.literal('reviews.cancel'), jobId: z.string().uuid().optional() }).strict(),
]);
export type ReviewRequest = z.infer<typeof reviewRequestSchema>;
export const progressSchema = z.object({ pages: z.number().int().nonnegative(), threads: z.number().int().nonnegative(), comments: z.number().int().nonnegative() }).strict();
// The last complete snapshot is deliberately separate from the current partial traversal.
export const reviewReplySchema = z.object({
  ok: z.boolean(), state: z.enum(['loading', 'complete', 'error', 'cancelled']), complete: z.boolean(),
  identity: prIdentitySchema.optional(), revision: z.string().uuid().optional(), jobId: z.string().uuid().optional(),
  snapshot: snapshotSchema.optional(), partial: reviewDataSchema.optional(), progress: progressSchema.optional(),
  freshness: z.enum(['fresh', 'stale', 'none']), persistence: z.enum(['cached', 'uncached', 'none']),
  error: reviewErrorSchema.optional(), warning: reviewErrorSchema.optional(),
}).strict();
export type ReviewReply = z.infer<typeof reviewReplySchema>;
export function reviewFailure(code: ReviewErrorCode): ReviewReply {
  return { ok: false, state: 'error', complete: false, freshness: 'none', persistence: 'none', error: { code } };
}
export async function requestReviews(request: ReviewRequest): Promise<ReviewReply> {
  try {
    const result = reviewReplySchema.safeParse(await chrome.runtime.sendMessage(request));
    return result.success ? result.data : reviewFailure('UNEXPECTED_RESPONSE');
  } catch { return reviewFailure('WORKER_UNAVAILABLE'); }
}
export function counts(data: ReviewData) {
  const resolved = data.threads.filter(thread => thread.isResolved).length;
  return { total: data.threads.length, resolved, unresolved: data.threads.length - resolved,
    outdated: data.threads.filter(thread => thread.isOutdated).length,
    comments: data.threads.reduce((sum, thread) => sum + thread.comments.length, 0) };
}
