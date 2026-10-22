import { z } from 'zod';
import type { PanelStatus } from '../../shared/panel';
import { REVIEW_CACHE_KEY, GRAPHQL_RETRY_KEY, SECONDARY_RETRY_KEY } from '../reviews/keys';
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
export type CredentialLease = { token: string; accountId: number; revision: string; epoch: number };
export type CredentialAccess = ReturnType<typeof createAuthController>['credentials'];
type Sender = Pick<chrome.runtime.MessageSender, 'id' | 'url' | 'origin' | 'frameId'>;

export function createAuthController(deps: {
  storage: AuthStorage; api: AuthApi; extensionId: string; now?: () => number;
}) {
  const { storage, api, extensionId } = deps;
  const now = deps.now ?? Date.now;
  let record: AuthRecord | null = null;
  let retryAt = 0;
  let generation = 0;
  let epoch = 0;
  let graphqlRetryAt = 0;
  let secondaryRetryAt = 0;
  const listeners = new Set<() => void>();
  function invalidate() { epoch++; listeners.forEach(listener => listener()); }
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
    const saved = await storage.get([AUTH_KEY, RETRY_KEY, GRAPHQL_RETRY_KEY, SECONDARY_RETRY_KEY]);
    record = saved[AUTH_KEY] === undefined ? null : recordSchema.parse(saved[AUTH_KEY]);
    retryAt = saved[RETRY_KEY] === undefined ? 0 : z.number().finite().nonnegative().parse(saved[RETRY_KEY]);
    const cooldown = z.object({ version: z.literal(1), retryAt: z.number().finite().nonnegative() });
    graphqlRetryAt = saved[GRAPHQL_RETRY_KEY] === undefined ? 0 : cooldown.parse(saved[GRAPHQL_RETRY_KEY]).retryAt;
    secondaryRetryAt = saved[SECONDARY_RETRY_KEY] === undefined ? 0 : cooldown.parse(saved[SECONDARY_RETRY_KEY]).retryAt;
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
    const until = Math.max(retryAt, secondaryRetryAt);
    if (until > now()) throw new AuthFailure('RATE_LIMITED', until);
  }
  async function saveRecord(next: AuthRecord) {
    const changed = record?.revision !== next.revision || next.health === 'invalid';
    await persist({ [AUTH_KEY]: next, ...(changed ? { [REVIEW_CACHE_KEY]: { version: 1, entries: [] } } : {}) });
    record = next;
    if (changed) invalidate();
  }
  async function persistCooldown(error: unknown, resource: 'rest' | 'graphql') {
    if (!(error instanceof AuthFailure) || error.retryAt === undefined) return;
    const until = error.retryAt;
    if (error.secondary) {
      const next = Math.max(secondaryRetryAt, until);
      await persist({ [SECONDARY_RETRY_KEY]: { version: 1, retryAt: next } });
      secondaryRetryAt = next;
    } else if (resource === 'graphql') {
      const next = Math.max(graphqlRetryAt, until);
      await persist({ [GRAPHQL_RETRY_KEY]: { version: 1, retryAt: next } });
      graphqlRetryAt = next;
    } else {
      const next = Math.max(retryAt, until);
      await persist({ [RETRY_KEY]: next });
      retryAt = next;
    }
  }
  function checkLease(lease: CredentialLease) {
    if (!record || record.revision !== lease.revision || epoch !== lease.epoch) throw new AuthFailure('SUPERSEDED');
    if (record.health === 'invalid') throw new AuthFailure('INVALID_TOKEN');
  }
  async function initialized() {
    if (!await ready) throw new AuthFailure('STORAGE');
  }
  // Worker-only capability. Network work runs outside the short serialized commit lock.
  const credentials = {
    async panelStatus(): Promise<PanelStatus> {
      await initialized();
      return exclusive(() => record ? { connected: true, health: record.health, revision: record.revision } : { connected: false });
    },
    async acquire(): Promise<CredentialLease> {
      await initialized();
      return exclusive(() => {
        if (!record) throw new AuthFailure('NOT_CONNECTED');
        if (record.health === 'invalid') throw new AuthFailure('INVALID_TOKEN');
        return { token: record.token, accountId: record.account.id, revision: record.revision, epoch };
      });
    },
    async run<T>(lease: CredentialLease, action: () => Promise<T> | T): Promise<T> {
      await initialized();
      return exclusive(() => { checkLease(lease); return action(); });
    },
    async checkRequest(lease: CredentialLease) {
      return this.run(lease, () => {
        const until = Math.max(graphqlRetryAt, secondaryRetryAt);
        if (until > now()) throw new AuthFailure('RATE_LIMITED', until);
      });
    },
    async reportFailure(lease: CredentialLease, error: unknown) {
      return this.run(lease, async () => {
        await persistCooldown(error, 'graphql');
        if (error instanceof AuthFailure && error.code === 'INVALID_TOKEN' && record) {
          await saveRecord({ ...record, health: 'invalid', lastError: 'INVALID_TOKEN' });
        }
      });
    },
    onChange(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  async function failure(error: unknown, expected: number, recheck: boolean, savedCredential: boolean): Promise<never> {
    return exclusive(async () => {
      checkGeneration(expected);
      const safe = safeError(error);
      await persistCooldown(error, 'rest');
      if (record && (recheck || (savedCredential && safe.code === 'INVALID_TOKEN'))) {
        await saveRecord({ ...record, health: safe.code === 'INVALID_TOKEN' ? 'invalid' : 'unknown', lastError: safe.code });
      }
      throw new AuthFailure(safe.code, safe.retryAt);
    });
  }

  async function execute(request: AuthRequest): Promise<AuthReply> {
    if (request.type === 'auth.status') return exclusive(() => ({ ok: true, status: status() }));
    if (request.type === 'auth.disconnect') return exclusive(async () => {
      generation++;
      invalidate();
      try { await storage.remove([AUTH_KEY, RETRY_KEY, REVIEW_CACHE_KEY, GRAPHQL_RETRY_KEY]); } catch { throw new AuthFailure('STORAGE'); }
      record = null;
      retryAt = 0;
      graphqlRetryAt = 0;
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
      return failure(error, snapshot.generation, request.type === 'auth.recheck', request.type !== 'auth.connect');
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
  return { handle, credentials };
}
