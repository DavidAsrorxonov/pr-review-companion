import { vi } from 'vitest';
import { createAuthController } from '../auth/controller';
import type { AuthStorage } from '../auth/controller';
import { createReviewController } from './controller';
import { createReviewApi } from './github';

export const extensionId = 'test-extension';
export const origin = `chrome-extension://${extensionId}`;
export const sender = { id: extensionId, url: `${origin}/src/options/options.html`, origin, frameId: 0, documentId: 'document-one' };
export const identity = { owner: 'octocat', repo: 'hello-world', number: 123 };
export const token = 'github_pat_FAKE_FIXTURE_NOT_A_CREDENTIAL';
export const pageInfo = (next: string | null = null) => ({ hasNextPage: next !== null, endCursor: next });
export function comment(id = 'C1', state = 'SUBMITTED', body = 'A review comment') {
  return { id, state, body, url: 'https://github.com/octocat/hello-world/pull/123#discussion_r1',
    author: { login: 'reviewer' }, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z' };
}
export function thread(id = 'T1', nodes = [comment()], next: string | null = null) {
  return { id, isResolved: false, isOutdated: false, path: 'src/index.ts', line: 10, originalLine: 10,
    startLine: null, originalStartLine: null, diffSide: 'RIGHT', startDiffSide: null,
    comments: { nodes, pageInfo: pageInfo(next) } };
}
export function page(nodes: unknown[] = [thread()], next: string | null = null) {
  return { data: { repository: { pullRequest: { id: 'PR1', number: 123, title: 'A pull request',
    url: 'https://github.com/octocat/hello-world/pull/123', state: 'OPEN', isDraft: false,
    reviewThreads: { nodes, pageInfo: pageInfo(next) } } } } };
}
export const response = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
export function setup() {
  const data: Record<string, unknown> = {};
  let time = 1_000;
  const storage = {
    setAccessLevel: vi.fn<AuthStorage['setAccessLevel']>().mockResolvedValue(undefined),
    get: vi.fn<AuthStorage['get']>().mockImplementation(async keys => Object.fromEntries(keys.filter(k => k in data).map(k => [k, structuredClone(data[k])]))),
    set: vi.fn<AuthStorage['set']>().mockImplementation(async items => { Object.assign(data, structuredClone(items)); }),
    remove: vi.fn<AuthStorage['remove']>().mockImplementation(async keys => { keys.forEach(k => { delete data[k]; }); }),
  };
  const identify = vi.fn().mockResolvedValue({ id: 42, login: 'octocat' });
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => response(page()));
  const now = () => time;
  function restart() {
    const auth = createAuthController({ storage, api: { identify, checkRepository: vi.fn() }, extensionId, now });
    const reviews = createReviewController({ storage, credentials: auth.credentials, api: createReviewApi(fetcher, now), extensionId, now });
    return { auth, reviews };
  }
  const { auth, reviews } = restart();
  const connect = (value = token) => auth.handle({ type: 'auth.connect', token: value }, sender);
  const load = (refresh = false, caller = sender) => reviews.handle({ type: 'reviews.load', pr: identity, refresh }, caller);
  return { data, storage, auth, reviews, fetcher, identify, restart, connect, load, advance: (ms: number) => { time += ms; } };
}
