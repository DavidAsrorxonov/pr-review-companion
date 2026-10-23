import { describe, expect, it, vi } from 'vitest';
import { createNotesController } from './controller';
import { NOTES_KEY } from './store';
import { AuthFailure } from '../auth/errors';
import { deferred, extensionId, identity, sender, setup, token } from '../reviews/fixtures.test-support';
import type { NotesReply } from '../../shared/notes';

const prUrl = 'https://github.com/octocat/hello-world/pull/123';
const content = { id: extensionId, origin: 'https://github.com', url: prUrl,
  frameId: 0, documentId: 'content-document', documentLifecycle: 'active' as const, tab: { id: 4 } };
const id = '00000000-0000-4000-8000-000000000001';
async function fixture() {
  const getTab = vi.fn().mockResolvedValue({ url: prUrl }); const s = setup(getTab);
  const changed = vi.fn().mockResolvedValue(undefined);
  const make = (auth = s.auth) => createNotesController({ account: auth.localAccount, storage: s.storage, extensionId, getTab, changed, now: () => 1000 });
  const controller = make(); await s.connect();
  const status = await s.auth.credentials.panelStatus(); if (!status.connected) throw Error();
  const request = (extra: object = {}) => ({ type: 'notes.list', pr: identity, revision: status.revision, ...extra });
  const send = (extra: object = {}) => controller.handle(request(extra), content);
  const create = (text = 'Private local note', noteId = id) => send({ type: 'notes.create', id: noteId, text });
  return { ...s, controller, changed, make, getTab, request, send, create, revision: status.revision };
}
const notes = (reply: NotesReply) => { if (!reply.ok) throw Error(reply.error.code); return reply.notes; };

describe('persistent account-scoped notes', () => {
  it('creates, edits, completes, reopens, and deletes without API calls', async () => {
    const s = await fixture(); expect(notes(await s.send())).toEqual([]);
    expect(notes(await s.create())).toEqual([{ id, text: 'Private local note', done: false, version: 1, createdAt: 1000, updatedAt: 1000 }]);
    expect(notes(await s.send({ type: 'notes.update', id, expectedVersion: 1, text: 'Updated\ntext', done: true }))[0]).toMatchObject({ text: 'Updated\ntext', done: true, version: 2 });
    expect(notes(await s.send({ type: 'notes.update', id, expectedVersion: 2, done: false }))[0]?.done).toBe(false);
    expect(notes(await s.send({ type: 'notes.delete', id, expectedVersion: 3 }))).toEqual([]);
    expect(s.changed).toHaveBeenCalledTimes(4); expect(s.fetcher).not.toHaveBeenCalled(); expect(s.identify).toHaveBeenCalledOnce();
  });
  it('retries a create without duplicating or overwriting an existing note', async () => {
    const s = await fixture(); await s.create(); await s.create();
    expect(notes(await s.send())).toHaveLength(1);
    expect(await s.create('Other text')).toMatchObject({ error: { code: 'CONFLICT' } });
    expect(notes(await s.send())[0]?.text).toBe('Private local note');
  });
  it('retains notes across worker restarts and same-account replacement', async () => {
    const s = await fixture(); await s.create();
    expect(notes(await s.make(s.restart().auth).handle(s.request(), content))).toHaveLength(1);
    const replaced = await s.connect('github_pat_new_fixture'); if (!replaced.ok || !replaced.status.connected) throw Error();
    expect(await s.send()).toMatchObject({ error: { code: 'SUPERSEDED' } });
    expect(notes(await s.send({ revision: replaced.status.revision }))).toHaveLength(1);
  });
  it('preserves notes through disconnect, isolates other accounts, and restores the original account', async () => {
    const s = await fixture(); await s.create();
    await s.auth.handle({ type: 'auth.disconnect' }, sender);
    expect(s.data[NOTES_KEY]).toBeDefined(); expect(await s.send()).toMatchObject({ error: { code: 'NOT_CONNECTED' } });
    s.identify.mockResolvedValue({ id: 99, login: 'another' }); const other = await s.connect();
    if (!other.ok || !other.status.connected) throw Error();
    expect(notes(await s.send({ revision: other.status.revision }))).toEqual([]);
    await s.send({ type: 'notes.create', id, text: 'Other account', revision: other.status.revision });
    s.identify.mockResolvedValue({ id: 42, login: 'renamed-account' }); const original = await s.connect();
    if (!original.ok || !original.status.connected) throw Error();
    expect(notes(await s.send({ revision: original.status.revision }))[0]?.text).toBe('Private local note');
  });
  it.each(['INVALID_TOKEN', 'NETWORK'] as const)('allows local reads/writes after connection health becomes %s', async code => {
    const s = await fixture(); s.identify.mockRejectedValue(new AuthFailure(code));
    await s.auth.handle({ type: 'auth.recheck' }, sender);
    expect(notes(await s.create())).toHaveLength(1); expect(notes(await s.send())).toHaveLength(1);
    expect(s.fetcher).not.toHaveBeenCalled();
  });
  it('failed replacement preserves connection scope and notes', async () => {
    const s = await fixture(); await s.create(); s.identify.mockRejectedValue(new AuthFailure('INVALID_TOKEN'));
    await s.connect('invalid_fixture'); expect(notes(await s.send())).toHaveLength(1);
  });
  it('rejects stale versions from concurrent updates and deletes', async () => {
    const s = await fixture(); await s.create();
    const results = await Promise.all([
      s.send({ type: 'notes.update', id, expectedVersion: 1, text: 'Winner' }),
      s.send({ type: 'notes.delete', id, expectedVersion: 1 }),
    ]);
    expect(results.filter(reply => reply.ok)).toHaveLength(1);
    expect(results[1]).toMatchObject({ error: { code: 'CONFLICT' } });
    expect(notes(await s.send())[0]?.text).toBe('Winner');
    await s.send({ type: 'notes.delete', id, expectedVersion: 2 });
    expect(await s.send({ type: 'notes.update', id, expectedVersion: 2, text: 'Resurrect' })).toMatchObject({ error: { code: 'NOT_FOUND' } });
  });
  it('serializes pending saves before disconnect without moving data to another account', async () => {
    const s = await fixture(); const gate = deferred<void>(); const original = s.storage.set.getMockImplementation()!;
    s.storage.set.mockImplementationOnce(async items => { await gate.promise; await original(items); });
    const pending = s.create(); await vi.waitFor(() => expect(s.storage.set).toHaveBeenCalledTimes(2));
    const disconnect = s.auth.handle({ type: 'auth.disconnect' }, sender); gate.resolve();
    const result = await pending; await disconnect;
    expect(result.ok).toBe(false); expect(s.data[NOTES_KEY]).toBeDefined();
    expect(await s.send()).toMatchObject({ error: { code: 'NOT_CONNECTED' } });
  });
});

describe('notes boundary and failure handling', () => {
  it.each([
    { ...content, id: 'wrong' }, { ...content, frameId: 1 }, { ...content, origin: 'https://evil.test' },
    { ...content, url: 'https://evil.test' }, { ...content, documentId: undefined },
    { ...content, documentLifecycle: 'cached' as const }, { ...content, tab: undefined },
    sender, { ...sender, url: `chrome-extension://${extensionId}/src/popup/popup.html` },
  ])('rejects forbidden sender %# without exposing notes or secrets', async caller => {
    const s = await fixture(); await s.create();
    const reply = await s.controller.handle(s.request(), caller);
    expect(reply).toEqual({ ok: false, error: { code: 'FORBIDDEN_CALLER' } });
    expect(JSON.stringify(reply)).not.toContain('Private local note'); expect(JSON.stringify(reply)).not.toContain(token);
  });
  it.each([
    { type: 'notes.create', id, text: '' }, { type: 'notes.create', id, text: ' \n ' },
    { type: 'notes.create', id, text: 'x'.repeat(10001) }, { type: 'notes.create', id: 'invalid', text: 'Note' },
    { accountId: 99 }, { token }, { key: NOTES_KEY }, { url: 'https://evil.test' },
    { revision: 'invalid' }, { type: 'notes.update', id, expectedVersion: 1 },
    { type: 'notes.update', id, expectedVersion: 0, done: true }, { type: 'notes.clear' },
  ])('rejects malformed requests %# with a sanitized error', async extra => {
    const s = await fixture(); expect(await s.send(extra)).toEqual({ ok: false, error: { code: 'INVALID_REQUEST' } });
    expect(s.data[NOTES_KEY]).toBeUndefined();
  });
  it('rejects wrong-PR tabs and navigation before commit and before reply', async () => {
    const s = await fixture();
    s.getTab.mockResolvedValue({ url: 'https://github.com/octocat/hello-world' });
    expect(await s.create()).toMatchObject({ error: { code: 'FORBIDDEN_CALLER' } });
    s.getTab.mockReset().mockResolvedValue({ url: prUrl });
    s.getTab.mockResolvedValueOnce({ url: prUrl }).mockResolvedValueOnce({ url: prUrl }).mockResolvedValueOnce({ url: prUrl + '4' });
    expect(await s.create()).toMatchObject({ error: { code: 'FORBIDDEN_CALLER' } }); expect(s.data[NOTES_KEY]).toBeUndefined();
    s.getTab.mockReset().mockResolvedValue({ url: prUrl });
    const original = s.storage.set.getMockImplementation()!;
    s.storage.set.mockImplementationOnce(async items => { await original(items); s.getTab.mockResolvedValue({ url: prUrl + '4' }); });
    expect(await s.create()).toMatchObject({ error: { code: 'FORBIDDEN_CALLER' } }); expect(s.data[NOTES_KEY]).toBeDefined();
  });
  it('fails closed on initialization failure without accessing the notes record', async () => {
    const s = await fixture(); s.storage.setAccessLevel.mockRejectedValue(new Error(token));
    const fresh = s.make(s.restart().auth); s.storage.get.mockClear();
    expect(await fresh.handle(s.request(), content)).toEqual({ ok: false, error: { code: 'STORAGE' } });
    expect(s.storage.get).not.toHaveBeenCalled();
  });
  it.each([null, {}, { version: 2, collections: [] }, { version: 1, collections: [{ notes: [] }] }])('does not overwrite corrupt persisted data %#', async bad => {
    const s = await fixture(); s.data[NOTES_KEY] = bad;
    expect(await s.create()).toEqual({ ok: false, error: { code: 'CORRUPT' } }); expect(s.data[NOTES_KEY]).toEqual(bad);
  });
  it('preserves existing records when storage fails and does not leak raw errors', async () => {
    const s = await fixture(); await s.create(); const original = structuredClone(s.data[NOTES_KEY]);
    s.storage.set.mockRejectedValueOnce(new Error(token + ' private text'));
    expect(await s.send({ type: 'notes.update', id, expectedVersion: 1, text: 'Unsaved' })).toEqual({ ok: false, error: { code: 'STORAGE' } });
    expect(s.data[NOTES_KEY]).toEqual(original);
    s.storage.get.mockRejectedValueOnce(new Error(token));
    expect(await s.send()).toEqual({ ok: false, error: { code: 'STORAGE' } });
  });
  it('enforces 200 notes per PR without evicting saved notes', async () => {
    const s = await fixture(); const saved = notes(await s.create())[0]!;
    s.data[NOTES_KEY] = { version: 1, collections: [{ accountId: 42, pr: identity,
      notes: Array.from({ length: 200 }, () => ({ ...saved, id: crypto.randomUUID() })) }] };
    expect(await s.create('Overflow', crypto.randomUUID())).toMatchObject({ error: { code: 'CAPACITY' } });
    expect(notes(await s.send())).toHaveLength(200);
  });
  it('enforces the total byte limit across accounts and allows space to be reclaimed', async () => {
    const s = await fixture(); const saved = notes(await s.create())[0]!;
    const large = Array.from({ length: 100 }, () => ({ ...saved, id: crypto.randomUUID(), text: '界'.repeat(6900) }));
    s.data[NOTES_KEY] = { version: 1, collections: [{ accountId: 99, pr: identity, notes: large }, { accountId: 42, pr: identity, notes: [saved] }] };
    const before = structuredClone(s.data[NOTES_KEY]);
    expect(await s.create('界'.repeat(10000), crypto.randomUUID())).toMatchObject({ error: { code: 'CAPACITY' } });
    expect(s.data[NOTES_KEY]).toEqual(before);
    expect(notes(await s.send({ type: 'notes.delete', id, expectedVersion: 1 }))).toEqual([]);
  });
});
