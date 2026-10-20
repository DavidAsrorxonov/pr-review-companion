import { z } from 'zod';
import { accountSchema, errorCodeSchema, requestSchema } from '../../shared/auth';
import type { AuthReply, AuthRequest, AuthStatus } from '../../shared/auth';
import type { AuthApi } from './github';
import { AuthFailure, safeError } from './errors';

export const AUTH_KEY = 'prrc.auth.v1';
export const RETRY_KEY = 'prrc.auth.retryAt';
const recordSchema = z.object({
  version: z.literal(1), token: z.string().min(1).max(4096), account: accountSchema,
  verifiedAt: z.number().finite().nonnegative(), revision: z.string().uuid(),
  health: z.enum(['verified', 'invalid', 'unknown']), lastError: errorCodeSchema.optional(),
}).strict();
type AuthRecord = z.infer<typeof recordSchema>;
export interface AuthStorage {
  setAccessLevel(options: { accessLevel: 'TRUSTED_CONTEXTS' }): Promise<void>;
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string[]): Promise<void>;
}
type Sender = Pick<chrome.runtime.MessageSender, 'id' | 'url' | 'origin' | 'frameId'>;

export function createAuthController(deps: {
  storage: AuthStorage; api: AuthApi; extensionId: string; now?: () => number;
}) {
  const { storage, api, extensionId } = deps;
  const now = deps.now ?? Date.now;
  let record: AuthRecord | null = null;
  let retryAt = 0;
  let generation = 0;
  let queue: Promise<unknown> = Promise.resolve();

  // Only short read/commit sections are serialized; network work never holds the lock.
  function exclusive<T>(operation: () => Promise<T> | T): Promise<T> {
    const next = queue.then(operation);
    queue = next.catch(() => undefined);
    return next;
  }
  async function persist(items: Record<string, unknown>) {
    try { await storage.set(items); } catch { throw new AuthFailure('STORAGE'); }
  }
  const ready = (async () => {
    await storage.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
    const saved = await storage.get([AUTH_KEY, RETRY_KEY]);
    record = saved[AUTH_KEY] === undefined ? null : recordSchema.parse(saved[AUTH_KEY]);
    retryAt = saved[RETRY_KEY] === undefined ? 0 : z.number().finite().nonnegative().parse(saved[RETRY_KEY]);
    return true;
  })().catch(() => false);

  function status(): AuthStatus {
    if (!record) return { connected: false };
    return {
      connected: true, account: { ...record.account }, verifiedAt: record.verifiedAt,
      revision: record.revision, health: record.health,
      ...(record.lastError ? { lastError: record.lastError } : {}),
    };
  }
  function checkGeneration(expected: number) {
    if (expected !== generation) throw new AuthFailure('SUPERSEDED');
  }
  function checkCooldown() {
    if (retryAt > now()) throw new AuthFailure('RATE_LIMITED', retryAt);
  }
  async function saveRecord(next: AuthRecord) {
    await persist({ [AUTH_KEY]: next });
    record = next;
  }
  async function failure(error: unknown, expected: number, recheck: boolean): Promise<never> {
    return exclusive(async () => {
      checkGeneration(expected);
      const safe = safeError(error);
      if (safe.retryAt !== undefined) {
        const next = Math.max(retryAt, safe.retryAt);
        await persist({ [RETRY_KEY]: next });
        retryAt = next;
      }
      if (recheck && record) {
        await saveRecord({ ...record, health: safe.code === 'INVALID_TOKEN' ? 'invalid' : 'unknown', lastError: safe.code });
      }
      throw new AuthFailure(safe.code, safe.retryAt);
    });
  }

  async function execute(request: AuthRequest): Promise<AuthReply> {
    if (request.type === 'auth.status') return exclusive(() => ({ ok: true, status: status() }));
    if (request.type === 'auth.disconnect') return exclusive(async () => {
      generation++;
      try { await storage.remove([AUTH_KEY, RETRY_KEY]); } catch { throw new AuthFailure('STORAGE'); }
      record = null;
      retryAt = 0;
      return { ok: true, status: status() };
    });

    const snapshot = await exclusive(() => {
      checkCooldown();
      if (request.type !== 'auth.connect' && !record) throw new AuthFailure('NOT_CONNECTED');
      // New identity checks supersede older checks, including other-tab rechecks.
      if (request.type !== 'auth.checkRepository') generation++;
      return { generation, record };
    });
    const token = request.type === 'auth.connect' ? request.token : snapshot.record!.token;
    try {
      if (request.type === 'auth.checkRepository') {
        await api.checkRepository(token, request.owner, request.repo);
        return await exclusive(() => {
          checkGeneration(snapshot.generation);
          return { ok: true, status: status(), repository: { owner: request.owner, repo: request.repo, checkedAt: now() } };
        });
      }
      const account = await api.identify(token);
      return await exclusive(async () => {
        checkGeneration(snapshot.generation);
        if (request.type === 'auth.recheck' && account.id !== snapshot.record!.account.id) {
          throw new AuthFailure('UNEXPECTED_RESPONSE');
        }
        await saveRecord({
          version: 1, token, account, verifiedAt: now(), health: 'verified',
          revision: request.type === 'auth.connect' ? crypto.randomUUID() : snapshot.record!.revision,
        });
        return { ok: true, status: status() };
      });
    } catch (error) {
      return failure(error, snapshot.generation, request.type === 'auth.recheck');
    }
  }

  async function handle(raw: unknown, sender: Sender): Promise<AuthReply> {
    try {
      const origin = `chrome-extension://${extensionId}`;
      const options = `${origin}/src/options/options.html`;
      const popup = `${origin}/src/popup/popup.html`;
      if (sender.id !== extensionId || (sender.url !== options && sender.url !== popup)
        || (sender.origin !== undefined && sender.origin !== origin)
        || (sender.frameId !== undefined && sender.frameId !== 0)) throw new AuthFailure('FORBIDDEN_CALLER');
      const parsed = requestSchema.safeParse(raw);
      if (!parsed.success) throw new AuthFailure('INVALID_REQUEST');
      if (sender.url !== options && parsed.data.type !== 'auth.status') throw new AuthFailure('FORBIDDEN_CALLER');
      if (!await ready) throw new AuthFailure('STORAGE');
      return await execute(parsed.data);
    } catch (error) {
      return { ok: false, error: safeError(error) };
    }
  }
  return { handle };
}
