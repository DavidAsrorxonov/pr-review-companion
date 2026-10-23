import { z } from 'zod';
import { noteSchema, NOTE_LIMIT, NOTES_BYTES_LIMIT, type NotesRequest, type NotesErrorCode } from '../../shared/notes';
import { prIdentitySchema, type PrIdentity } from '../../shared/reviews';
import type { AuthStorage } from '../auth/controller';
import { samePr } from '../panel/access';

export const NOTES_KEY = 'prrc.notes.v1';
export class NotesFailure extends Error {
  constructor(readonly code: NotesErrorCode) { super(code); }
}
const recordSchema = z.object({ version: z.literal(1), collections: z.array(z.object({
  accountId: z.number().int().positive(), pr: prIdentitySchema, notes: z.array(noteSchema).max(NOTE_LIMIT),
}).strict()) }).strict().superRefine((record, ctx) => {
  const collections = new Set<string>();
  for (const collection of record.collections) {
    const key = `${collection.accountId}:${collection.pr.owner}/${collection.pr.repo}#${collection.pr.number}`;
    if (collections.has(key) || collection.pr.owner !== collection.pr.owner.toLowerCase() || collection.pr.repo !== collection.pr.repo.toLowerCase()
      || new Set(collection.notes.map(note => note.id)).size !== collection.notes.length) ctx.addIssue({ code: 'custom', message: 'Invalid collection' });
    collections.add(key);
  }
});

// The caller holds localAccount.run's commit lock for the entire read/modify/write.
export async function operateNotes(storage: Pick<AuthStorage, 'get' | 'set'>, accountId: number,
  request: NotesRequest, beforeWrite: () => Promise<void>, now = Date.now) {
  const saved = (await storage.get([NOTES_KEY]))[NOTES_KEY];
  const parsed = recordSchema.safeParse(saved ?? { version: 1, collections: [] });
  if (!parsed.success || saved === null) throw new NotesFailure('CORRUPT');
  const record = parsed.data;
  const pr: PrIdentity = { ...request.pr, owner: request.pr.owner.toLowerCase(), repo: request.pr.repo.toLowerCase() };
  let collection = record.collections.find(item => item.accountId === accountId && samePr(item.pr, pr));
  if (request.type === 'notes.list') return collection?.notes ?? [];
  if (!collection) { collection = { accountId, pr, notes: [] }; record.collections.push(collection); }
  const existing = collection.notes.find(note => note.id === request.id);
  if (request.type === 'notes.create') {
    if (existing) {
      if (existing.text !== request.text) throw new NotesFailure('CONFLICT');
      return collection.notes; // Stable create IDs make acknowledgement-loss retries safe.
    }
    if (collection.notes.length >= NOTE_LIMIT) throw new NotesFailure('CAPACITY');
    const timestamp = now();
    collection.notes.push({ id: request.id, text: request.text, done: false, version: 1, createdAt: timestamp, updatedAt: timestamp });
  } else {
    if (!existing) throw new NotesFailure('NOT_FOUND');
    if (existing.version !== request.expectedVersion) throw new NotesFailure('CONFLICT');
    if (request.type === 'notes.delete') collection.notes = collection.notes.filter(note => note !== existing);
    else {
      if (existing.version === Number.MAX_SAFE_INTEGER) throw new NotesFailure('CAPACITY');
      if (request.text !== undefined) existing.text = request.text;
      if (request.done !== undefined) existing.done = request.done;
      existing.version++; existing.updatedAt = Math.max(existing.updatedAt, now());
    }
  }
  record.collections = record.collections.filter(item => item.notes.length);
  if (new TextEncoder().encode(NOTES_KEY + JSON.stringify(record)).byteLength > NOTES_BYTES_LIMIT) throw new NotesFailure('CAPACITY');
  await beforeWrite();
  await storage.set({ [NOTES_KEY]: record });
  return collection.notes;
}
