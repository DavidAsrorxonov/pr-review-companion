import { z } from 'zod';

export const errorCodeSchema = z.enum([
  'INVALID_REQUEST', 'FORBIDDEN_CALLER', 'NOT_CONNECTED', 'INVALID_TOKEN',
  'FORBIDDEN', 'REPOSITORY_UNAVAILABLE', 'RATE_LIMITED', 'TIMEOUT', 'NETWORK',
  'UNEXPECTED_RESPONSE', 'STORAGE', 'SUPERSEDED', 'WORKER_UNAVAILABLE',
]);
export type AuthErrorCode = z.infer<typeof errorCodeSchema>;
export type AuthError = { code: AuthErrorCode; retryAt?: number };

export const errorMessages: Record<AuthErrorCode, string> = {
  INVALID_REQUEST: 'Check the token or repository format and try again.',
  FORBIDDEN_CALLER: 'This operation is not available from this page.',
  NOT_CONNECTED: 'Connect a GitHub account first.',
  INVALID_TOKEN: 'GitHub rejected this credential. It may be invalid, expired, or revoked.',
  FORBIDDEN: 'GitHub denied access. Check repository selection, permissions, and organization approval.',
  REPOSITORY_UNAVAILABLE: 'This repository was not found or is inaccessible with the saved token.',
  RATE_LIMITED: 'GitHub has temporarily limited requests. Try again after the indicated time.',
  TIMEOUT: 'GitHub did not respond within 15 seconds. Try again.',
  NETWORK: 'Could not reach GitHub. Check your connection and try again.',
  UNEXPECTED_RESPONSE: 'GitHub returned an unexpected response. Try again later.',
  STORAGE: 'Secure local storage is unavailable. Reload the extension and try again.',
  SUPERSEDED: 'The connection changed while this request was running. Check the current status.',
  WORKER_UNAVAILABLE: 'The extension worker could not be reached. Reload the extension and try again.',
};

export const accountSchema = z.object({
  id: z.number().int().positive(),
  login: z.string().min(1).max(100),
}).strict();
const timestamp = z.number().finite().nonnegative();
export const statusSchema = z.discriminatedUnion('connected', [
  z.object({ connected: z.literal(false) }).strict(),
  z.object({
    connected: z.literal(true),
    account: accountSchema,
    verifiedAt: timestamp,
    revision: z.string().uuid(),
    health: z.enum(['verified', 'invalid', 'unknown']),
    lastError: errorCodeSchema.optional(),
  }).strict(),
]);
export type AuthStatus = z.infer<typeof statusSchema>;

export const ownerSchema = z.string().min(1).max(100).regex(/^[a-zA-Z0-9][a-zA-Z0-9-]*$/);
export const repoSchema = z.string().min(1).max(100).regex(/^[a-zA-Z0-9_.-]+$/)
  .refine(value => value !== '.' && value !== '..');
export const requestSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('auth.status') }).strict(),
  z.object({
    type: z.literal('auth.connect'),
    token: z.string().trim().min(1).max(4096).regex(/^[\x21-\x7E]+$/),
  }).strict(),
  z.object({ type: z.literal('auth.recheck') }).strict(),
  z.object({ type: z.literal('auth.disconnect') }).strict(),
  z.object({ type: z.literal('auth.checkRepository'), owner: ownerSchema, repo: repoSchema }).strict(),
]);
export type AuthRequest = z.infer<typeof requestSchema>;

export const repositoryResultSchema = z.object({
  owner: ownerSchema,
  repo: repoSchema,
  checkedAt: timestamp,
}).strict();
export type RepositoryResult = z.infer<typeof repositoryResultSchema>;

export const replySchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), status: statusSchema, repository: repositoryResultSchema.optional() }).strict(),
  z.object({ ok: z.literal(false), error: z.object({ code: errorCodeSchema, retryAt: timestamp.optional() }).strict() }).strict(),
]);
export type AuthReply = z.infer<typeof replySchema>;

// Extension UI only. No storage or authenticated network access in this module.
export async function requestAuth(request: AuthRequest): Promise<AuthReply> {
  try {
    const reply: unknown = await chrome.runtime.sendMessage(request);
    const parsed = replySchema.safeParse(reply);
    return parsed.success ? parsed.data : { ok: false, error: { code: 'UNEXPECTED_RESPONSE' } };
  } catch {
    return { ok: false, error: { code: 'WORKER_UNAVAILABLE' } };
  }
}
