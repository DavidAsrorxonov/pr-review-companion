import { describe, expect, it, vi } from 'vitest';
import { AUTH_KEY, RETRY_KEY, createAuthController } from './controller';
import { AuthFailure } from './errors';
import type { AuthStorage } from './controller';

const extensionId = 'test-extension';
const origin = `chrome-extension://${extensionId}`;
const options = { id: extensionId, url: `${origin}/src/options/options.html`, origin, frameId: 0 };
const popup = { ...options, url: `${origin}/src/popup/popup.html` };
const account = { id: 42, login: 'octocat' };
const token = 'github_pat_fixture_DO_NOT_USE';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
function setup() {
  const data: Record<string, unknown> = {};
  const storage = {
    setAccessLevel: vi.fn<AuthStorage['setAccessLevel']>().mockResolvedValue(undefined),
    get: vi.fn<AuthStorage['get']>().mockImplementation(async keys => Object.fromEntries(keys.filter(k => k in data).map(k => [k, structuredClone(data[k])]))),
    set: vi.fn<AuthStorage['set']>().mockImplementation(async items => { Object.assign(data, structuredClone(items)); }),
    remove: vi.fn<AuthStorage['remove']>().mockImplementation(async keys => { keys.forEach(k => { delete data[k]; }); }),
  };
  const api = {
    identify: vi.fn<(token: string) => Promise<typeof account>>().mockResolvedValue(account),
    checkRepository: vi.fn<(token: string, owner: string, repo: string) => Promise<void>>().mockResolvedValue(undefined),
  };
  let time = 1_000;
  const make = () => createAuthController({ storage, api, extensionId, now: () => time });
  const controller = make();
  const handle = controller.handle;
  const connect = (value = token) => handle({ type: 'auth.connect', token: value }, options);
  const status = () => handle({ type: 'auth.status' }, popup);
  return { data, storage, api, make, handle, connect, status, advance: (next: number) => { time = next; } };
}

describe('credential boundary', () => {
  it('locks storage before reading or writing credentials', async () => {
    const gate = deferred<void>();
    const storage = { setAccessLevel: vi.fn().mockReturnValue(gate.promise), get: vi.fn().mockResolvedValue({}), set: vi.fn(), remove: vi.fn() };
    const api = { identify: vi.fn().mockResolvedValue(account), checkRepository: vi.fn() };
    const controller = createAuthController({ storage, api, extensionId });
    const response = controller.handle({ type: 'auth.connect', token }, options);
    expect(storage.setAccessLevel).toHaveBeenCalledWith({ accessLevel: 'TRUSTED_CONTEXTS' });
    expect(storage.get).not.toHaveBeenCalled();
    expect(api.identify).not.toHaveBeenCalled();
    gate.resolve();
    expect((await response).ok).toBe(true);
    expect(storage.get).toHaveBeenCalledOnce();
  });

  it('fails closed if access-level initialization fails', async () => {
    const storage = { setAccessLevel: vi.fn().mockRejectedValue(new Error(token)), get: vi.fn(), set: vi.fn(), remove: vi.fn() };
    const api = { identify: vi.fn(), checkRepository: vi.fn() };
    const controller = createAuthController({ storage, api, extensionId });
    expect(await controller.handle({ type: 'auth.connect', token }, options)).toEqual({ ok: false, error: { code: 'STORAGE' } });
    expect(storage.get).not.toHaveBeenCalled();
    expect(storage.set).not.toHaveBeenCalled();
    expect(api.identify).not.toHaveBeenCalled();
  });

  it.each([
    { ...options, id: 'other-extension' },
    { ...options, url: 'https://github.com/owner/repo/pull/1', origin: 'https://github.com' },
    { ...options, url: `${options.url}?impersonate=1` },
    { ...options, url: `${options.url}/spoof` },
    { ...options, origin: 'https://evil.example' },
    { ...options, frameId: 1 },
    {},
  ])('rejects an untrusted sender %# without leaking data', async sender => {
    const s = setup();
    await s.connect();
    expect(await s.handle({ type: 'auth.status' }, sender)).toEqual({ ok: false, error: { code: 'FORBIDDEN_CALLER' } });
  });

  it.each(['auth.connect', 'auth.disconnect', 'auth.recheck', 'auth.checkRepository'])('denies popup mutation %s', async type => {
    const s = setup();
    const request = type === 'auth.connect' ? { type, token }
      : type === 'auth.checkRepository' ? { type, owner: 'owner', repo: 'repo' } : { type };
    expect(await s.handle(request, popup)).toEqual({ ok: false, error: { code: 'FORBIDDEN_CALLER' } });
    expect(s.api.identify).not.toHaveBeenCalled();
  });

  it.each([
    null, { type: 'fetch', url: 'https://evil.example', token },
    { type: 'auth.connect', token: '' }, { type: 'auth.connect', token: 'line\nbreak' },
    { type: 'auth.connect', token, headers: { secret: token } },
    { type: 'auth.checkRepository', owner: 'owner', repo: '..' },
    { type: 'auth.checkRepository', owner: 'owner', repo: 'a/b' },
    { type: 'auth.checkRepository', owner: 'owner', repo: 'name?token=secret' },
  ])('rejects malformed payload %# with a fixed error', async request => {
    const s = setup();
    expect(await s.handle(request, options)).toEqual({ ok: false, error: { code: 'INVALID_REQUEST' } });
    expect(s.api.identify).not.toHaveBeenCalled();
    expect(s.api.checkRepository).not.toHaveBeenCalled();
  });
});

describe('connection lifecycle', () => {
  it('verifies before saving, trims input, and never returns the secret', async () => {
    const s = setup();
    const gate = deferred<typeof account>();
    s.api.identify.mockReturnValueOnce(gate.promise);
    const response = s.connect(` ${token} `);
    await vi.waitFor(() => expect(s.api.identify).toHaveBeenCalledWith(token));
    expect(s.data[AUTH_KEY]).toBeUndefined();
    gate.resolve(account);
    const reply = await response;
    expect(reply).toMatchObject({ ok: true, status: { connected: true, account, health: 'verified', verifiedAt: 1000 } });
    expect(JSON.stringify(reply)).not.toContain(token);
    expect(s.data[AUTH_KEY]).toMatchObject({ version: 1, token, account });
    const restarted = s.make();
    expect(await restarted.handle({ type: 'auth.status' }, popup)).toEqual(reply);
    expect(s.api.identify).toHaveBeenCalledTimes(1); // Status reads never call GitHub.
  });

  it('does not store failed initial credentials or replace a working connection on failure', async () => {
    const s = setup();
    s.api.identify.mockRejectedValueOnce(new AuthFailure('INVALID_TOKEN'));
    expect(await s.connect()).toEqual({ ok: false, error: { code: 'INVALID_TOKEN' } });
    expect(s.data[AUTH_KEY]).toBeUndefined();
    await s.connect();
    const saved = structuredClone(s.data[AUTH_KEY]);
    s.api.identify.mockRejectedValueOnce(new Error(`raw failure ${token}`));
    expect(await s.connect('replacement-fixture')).toEqual({ ok: false, error: { code: 'UNEXPECTED_RESPONSE' } });
    expect(s.data[AUTH_KEY]).toEqual(saved);
  });

  it('keeps the saved identity on a network failure and recovers on recheck', async () => {
    const s = setup();
    await s.connect();
    s.api.identify.mockRejectedValueOnce(new AuthFailure('NETWORK'));
    expect(await s.handle({ type: 'auth.recheck' }, options)).toEqual({ ok: false, error: { code: 'NETWORK' } });
    expect(await s.status()).toMatchObject({ ok: true, status: { connected: true, account, health: 'unknown', verifiedAt: 1000 } });
    s.advance(2000);
    expect(await s.handle({ type: 'auth.recheck' }, options)).toMatchObject({ ok: true, status: { health: 'verified', verifiedAt: 2000 } });
  });

  it('marks a rejected saved credential invalid without returning or erasing it', async () => {
    const s = setup(); await s.connect();
    s.api.identify.mockRejectedValueOnce(new AuthFailure('INVALID_TOKEN'));
    await s.handle({ type: 'auth.recheck' }, options);
    const result = await s.status();
    expect(result).toMatchObject({ status: { health: 'invalid', account } });
    expect(JSON.stringify(result)).not.toContain(token);
    expect(s.data[AUTH_KEY]).toMatchObject({ token });
  });

  it('removes only authentication keys on disconnect', async () => {
    const s = setup(); await s.connect();
    s.data.notes = { body: 'Preserve this' };
    expect(await s.handle({ type: 'auth.disconnect' }, options)).toEqual({ ok: true, status: { connected: false } });
    expect(s.data).toEqual({ notes: { body: 'Preserve this' } });
    expect(await s.make().handle({ type: 'auth.status' }, popup)).toEqual({ ok: true, status: { connected: false } });
  });

  it('does not claim to save or disconnect when storage fails', async () => {
    const s = setup(); await s.connect();
    const saved = structuredClone(s.data[AUTH_KEY]);
    s.storage.set.mockRejectedValueOnce(new Error(token));
    expect(await s.connect('new-fixture')).toEqual({ ok: false, error: { code: 'STORAGE' } });
    expect(s.data[AUTH_KEY]).toEqual(saved);
    s.storage.remove.mockRejectedValueOnce(new Error(token));
    expect(await s.handle({ type: 'auth.disconnect' }, options)).toEqual({ ok: false, error: { code: 'STORAGE' } });
    expect(await s.status()).toMatchObject({ status: { connected: true, account } });
  });
});

describe('concurrent operations', () => {
  it('does not let an older recheck overwrite the result of a newer recheck', async () => {
    const s = setup(); await s.connect(); const gate = deferred<typeof account>();
    s.api.identify.mockReturnValueOnce(gate.promise);
    const older = s.handle({ type: 'auth.recheck' }, options);
    await vi.waitFor(() => expect(s.api.identify).toHaveBeenCalledTimes(2));
    s.advance(2000);
    await s.handle({ type: 'auth.recheck' }, options);
    gate.reject(new AuthFailure('NETWORK'));
    expect(await older).toEqual({ ok: false, error: { code: 'SUPERSEDED' } });
    expect(await s.status()).toMatchObject({ status: { health: 'verified', verifiedAt: 2000 } });
  });

  it('does not resurrect a credential when a verification finishes after disconnect', async () => {
    const s = setup(); const gate = deferred<typeof account>();
    s.api.identify.mockReturnValueOnce(gate.promise);
    const pending = s.connect();
    await vi.waitFor(() => expect(s.api.identify).toHaveBeenCalledOnce());
    await s.handle({ type: 'auth.disconnect' }, options);
    gate.resolve(account);
    expect(await pending).toEqual({ ok: false, error: { code: 'SUPERSEDED' } });
    expect(await s.status()).toEqual({ ok: true, status: { connected: false } });
    expect(s.data[AUTH_KEY]).toBeUndefined();
  });

  it('keeps a newer connection when an older attempt completes late', async () => {
    const s = setup(); const gate = deferred<typeof account>();
    s.api.identify.mockReturnValueOnce(gate.promise);
    const older = s.connect();
    await vi.waitFor(() => expect(s.api.identify).toHaveBeenCalledOnce());
    s.api.identify.mockResolvedValueOnce({ id: 43, login: 'new-account' });
    await s.connect('new-token-fixture');
    gate.resolve(account);
    expect(await older).toEqual({ ok: false, error: { code: 'SUPERSEDED' } });
    expect(s.data[AUTH_KEY]).toMatchObject({ token: 'new-token-fixture', account: { id: 43 } });
  });

  it('ignores old recheck errors after replacement', async () => {
    const s = setup(); await s.connect(); const gate = deferred<typeof account>();
    s.api.identify.mockReturnValueOnce(gate.promise);
    const oldCheck = s.handle({ type: 'auth.recheck' }, options);
    await vi.waitFor(() => expect(s.api.identify).toHaveBeenCalledTimes(2));
    await s.connect('replacement-fixture');
    gate.reject(new AuthFailure('INVALID_TOKEN'));
    expect(await oldCheck).toEqual({ ok: false, error: { code: 'SUPERSEDED' } });
    expect(s.data[AUTH_KEY]).toMatchObject({ token: 'replacement-fixture', health: 'verified' });
  });

  it('does not return a stale repository success after disconnect', async () => {
    const s = setup(); await s.connect(); const gate = deferred<void>();
    s.api.checkRepository.mockReturnValueOnce(gate.promise);
    const pending = s.handle({ type: 'auth.checkRepository', owner: 'owner', repo: 'repo' }, options);
    await vi.waitFor(() => expect(s.api.checkRepository).toHaveBeenCalledOnce());
    await s.handle({ type: 'auth.disconnect' }, options); gate.resolve();
    expect(await pending).toEqual({ ok: false, error: { code: 'SUPERSEDED' } });
  });
});

describe('repository access and cooldown', () => {
  it('returns only the repository check outcome and keeps access errors separate', async () => {
    const s = setup();
    const request = { type: 'auth.checkRepository', owner: 'octocat', repo: 'hello-world' };
    expect(await s.handle(request, options)).toEqual({ ok: false, error: { code: 'NOT_CONNECTED' } });
    await s.connect();
    const saved = structuredClone(s.data[AUTH_KEY]);
    expect(await s.handle(request, options)).toMatchObject({ ok: true, repository: { owner: 'octocat', repo: 'hello-world', checkedAt: 1000 } });
    expect(s.api.checkRepository).toHaveBeenCalledWith(token, 'octocat', 'hello-world');
    s.api.checkRepository.mockRejectedValueOnce(new AuthFailure('REPOSITORY_UNAVAILABLE'));
    expect(await s.handle(request, options)).toEqual({ ok: false, error: { code: 'REPOSITORY_UNAVAILABLE' } });
    expect(s.data[AUTH_KEY]).toEqual(saved);
  });

  it('honors persisted cooldown across worker restart without retrying automatically', async () => {
    const s = setup();
    s.api.identify.mockRejectedValueOnce(new AuthFailure('RATE_LIMITED', 100_000));
    expect(await s.connect()).toEqual({ ok: false, error: { code: 'RATE_LIMITED', retryAt: 100_000 } });
    expect(s.data[RETRY_KEY]).toBe(100_000);
    const restart = s.make();
    expect(await restart.handle({ type: 'auth.connect', token }, options)).toEqual({ ok: false, error: { code: 'RATE_LIMITED', retryAt: 100_000 } });
    expect(s.api.identify).toHaveBeenCalledTimes(1);
    s.advance(100_001);
    expect((await restart.handle({ type: 'auth.connect', token }, options)).ok).toBe(true);
  });
});
