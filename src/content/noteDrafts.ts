// Document-memory only; shared across PR mounts, never written into page storage.
export type NoteDraft = { create: { id: string; text: string }; edit?: { id: string; text: string; version: number } };
export function createNoteDraftStore() {
  let revision: string | undefined;
  const drafts = new Map<string, NoteDraft>();
  return {
    clear() { drafts.clear(); revision = undefined; },
    get(key: string, currentRevision: string): NoteDraft {
      if (revision !== currentRevision) { drafts.clear(); revision = currentRevision; }
      let draft = drafts.get(key);
      if (!draft) { draft = { create: { id: crypto.randomUUID(), text: '' } }; drafts.set(key, draft); }
      return draft;
    },
  };
}
export const noteDrafts = createNoteDraftStore();
