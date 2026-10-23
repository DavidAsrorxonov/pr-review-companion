import {
  NOTE_TEXT_LIMIT,
  type Note,
  type NotesRequest,
  type NotesReply,
  type NotesErrorCode,
} from "../shared/notes";
import type { PrIdentity } from "../shared/prUrl";
import type { PanelView } from "./session";
import type { NoteDraft, createNoteDraftStore } from "../content/noteDrafts";

export type NotesView = {
  available: boolean;
  loading: boolean;
  busy: boolean;
  loaded: boolean;
  notes: Note[];
  draft?: NoteDraft;
  error?: NotesErrorCode;
  notice?: string;
  reconcile: boolean;
};
type Mutation =
  | { type: "notes.create"; id: string; text: string }
  | {
      type: "notes.update";
      id: string;
      expectedVersion: number;
      text?: string;
      done?: boolean;
    }
  | { type: "notes.delete"; id: string; expectedVersion: number };
export function createNotesSession(
  pr: PrIdentity,
  send: (request: NotesRequest) => Promise<NotesReply>,
  drafts: ReturnType<typeof createNoteDraftStore>,
  isCurrent: () => boolean,
) {
  let state: NotesView = {
    available: false,
    loading: false,
    busy: false,
    loaded: false,
    notes: [],
    reconcile: false,
  };
  let revision: string | undefined;
  let generation = 0;
  let requestSequence = 0;
  let disposed = false;
  let refreshPending = false;
  const listeners = new Set<() => void>();
  const key = `${pr.owner}/${pr.repo}#${pr.number}`;
  function update(next: Partial<NotesView>) {
    if (disposed) return;
    state = { ...state, ...next };
    listeners.forEach((listener) => listener());
  }
  function valid(current: number, sequence: number) {
    return (
      !disposed &&
      state.available &&
      isCurrent() &&
      current === generation &&
      sequence === requestSequence
    );
  }
  function accept(reply: NotesReply) {
    if (!reply.ok) {
      if (
        reply.error.code === "NOT_CONNECTED" ||
        reply.error.code === "SUPERSEDED"
      ) {
        drafts.clear();
        update({
          available: false,
          draft: undefined,
          notes: [],
          loaded: false,
        });
      }
      update({ error: reply.error.code });
      return false;
    }
    if (
      reply.revision !== revision ||
      reply.pr.owner !== pr.owner ||
      reply.pr.repo !== pr.repo ||
      reply.pr.number !== pr.number
    ) {
      update({ error: "SUPERSEDED", notes: [], loaded: false });
      return false;
    }
    const draft = state.draft;
    if (draft) {
      // Reconcile writes whose acknowledgement was lost across close/reload/focus.
      const created = reply.notes.find((note) => note.id === draft.create.id);
      if (created && created.text === draft.create.text)
        draft.create = { id: crypto.randomUUID(), text: "" };
      const edited =
        draft.edit && reply.notes.find((note) => note.id === draft.edit!.id);
      if (
        edited &&
        draft.edit &&
        edited.version > draft.edit.version &&
        edited.text === draft.edit.text
      )
        draft.edit = undefined;
    }
    update({ notes: reply.notes, loaded: true, draft, reconcile: false });
    return true;
  }
  async function load() {
    if (!state.available || !revision || disposed || !isCurrent()) return;
    if (state.busy) {
      refreshPending = true;
      return;
    }
    const current = generation;
    const sequence = ++requestSequence;
    update({ loading: true, error: undefined });
    const reply = await send({ type: "notes.list", pr, revision });
    if (!valid(current, sequence)) return;
    accept(reply);
    update({ loading: false });
  }
  async function mutate(mutation: Mutation) {
    if (
      !state.available ||
      !state.loaded ||
      !revision ||
      state.busy ||
      state.loading ||
      state.reconcile ||
      !isCurrent()
    )
      return;
    const current = generation;
    const sequence = ++requestSequence;
    update({ busy: true, error: undefined, notice: undefined });
    const reply = await send({ ...mutation, pr, revision });
    if (!valid(current, sequence)) return;
    const success = accept(reply);
    update({
      busy: false,
      notice: success
        ? mutation.type === "notes.delete"
          ? "Note deleted."
          : "Note saved locally."
        : undefined,
      reconcile: !success,
    });
    // Refresh after an error/conflict before allowing any retry. Do not lose its message.
    if (!success || refreshPending) {
      refreshPending = false;
      const error = state.error;
      await load();
      if (current === generation && !disposed && error) update({ error });
    }
  }
  function draftChanged() {
    update({ draft: state.draft, notice: undefined });
  }
  function editable() {
    return state.available && !!state.draft && !state.busy;
  }
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    sync(panel: PanelView) {
      const next =
        panel.open && !panel.checking && panel.status?.connected
          ? panel.status.revision
          : undefined;
      if (next === revision && state.available === !!next) return;
      generation++;
      requestSequence++;
      refreshPending = false;
      revision = next;
      update({
        available: !!next,
        notes: [],
        loaded: false,
        busy: false,
        loading: false,
        error: undefined,
        notice: undefined,
        reconcile: false,
        draft: next ? drafts.get(key, next) : undefined,
      });
      if (next) void load();
    },
    load,
    invalidate() {
      if (state.available) void load();
    },
    setNewText(text: string) {
      if (editable() && text.length <= NOTE_TEXT_LIMIT) {
        state.draft!.create.text = text;
        draftChanged();
      }
    },
    add() {
      if (state.draft?.create.text.trim())
        void mutate({ type: "notes.create", ...state.draft.create });
    },
    edit(note: Note) {
      if (editable() && !state.draft!.edit) {
        state.draft!.edit = {
          id: note.id,
          text: note.text,
          version: note.version,
        };
        draftChanged();
      }
    },
    setEditText(text: string) {
      if (editable() && state.draft!.edit && text.length <= NOTE_TEXT_LIMIT) {
        state.draft!.edit.text = text;
        draftChanged();
      }
    },
    cancelEdit() {
      if (editable()) {
        state.draft!.edit = undefined;
        draftChanged();
      }
    },
    saveEdit() {
      const edit = state.draft?.edit;
      if (edit?.text.trim())
        void mutate({
          type: "notes.update",
          id: edit.id,
          text: edit.text,
          expectedVersion: edit.version,
        });
    },
    useLatest(keepDraft: boolean) {
      const edit = state.draft?.edit;
      const latest = edit && state.notes.find((note) => note.id === edit.id);
      if (editable() && latest && edit) {
        state.draft!.edit = {
          id: latest.id,
          text: keepDraft ? edit.text : latest.text,
          version: latest.version,
        };
        draftChanged();
      }
    },
    copyEditToNew() {
      if (editable() && state.draft!.edit && !state.draft!.create.text.trim()) {
        state.draft!.create = {
          id: crypto.randomUUID(),
          text: state.draft!.edit.text,
        };
        state.draft!.edit = undefined;
        draftChanged();
      }
    },
    toggle(note: Note) {
      void mutate({
        type: "notes.update",
        id: note.id,
        expectedVersion: note.version,
        done: !note.done,
      });
    },
    remove(note: Note) {
      void mutate({
        type: "notes.delete",
        id: note.id,
        expectedVersion: note.version,
      });
    },
    dispose() {
      generation++;
      disposed = true;
      listeners.clear();
    },
  };
}
export type NotesSession = ReturnType<typeof createNotesSession>;
