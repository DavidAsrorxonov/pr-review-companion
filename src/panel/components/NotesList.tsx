import { useId, useState, useSyncExternalStore } from "react";
import { NOTE_TEXT_LIMIT, notesErrors, type Note } from "../../shared/notes";
import type { NotesSession } from "../notesSession";

export function NotesList({
  session,
  checking,
}: {
  session: NotesSession;
  checking: boolean;
}) {
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const [confirmDelete, setConfirmDelete] = useState<string>();
  const newId = useId();
  const editId = useId();
  const ordered = [...state.notes].sort(
    (a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id),
  );
  const open = ordered.filter((note) => !note.done);
  const done = ordered.filter((note) => note.done);
  const disabled =
    state.busy || state.loading || !state.loaded || state.reconcile;
  const edit = state.draft?.edit;
  const latest = edit && state.notes.find((note) => note.id === edit.id);
  const conflict = !!edit && (!latest || edit.version !== latest.version);
  function row(note: Note) {
    return (
      <li key={note.id} className="local-note">
        <label className="note-checkbox">
          <input
            type="checkbox"
            checked={note.done}
            disabled={disabled || edit?.id === note.id}
            onChange={() => session.toggle(note)}
          />
          Done
        </label>
        <p className="comment-body">{note.text}</p>
        <p className="meta">
          Updated {new Date(note.updatedAt).toLocaleString()}
        </p>
        <div className="controls mt-2">
          <button
            type="button"
            disabled={disabled || !!edit}
            onClick={() => session.edit(note)}
          >
            Edit
          </button>
          <button
            type="button"
            disabled={disabled || edit?.id === note.id}
            onClick={() => setConfirmDelete(note.id)}
          >
            Delete
          </button>
        </div>
        {confirmDelete === note.id && (
          <div className="note-confirm">
            <p>Delete this local note? This cannot be undone.</p>
            <button
              type="button"
              disabled={disabled}
              onClick={() => {
                session.remove(note);
                setConfirmDelete(undefined);
              }}
            >
              Confirm delete
            </button>{" "}
            <button type="button" onClick={() => setConfirmDelete(undefined)}>
              Keep note
            </button>
          </div>
        )}
      </li>
    );
  }
  return (
    <details className="local-notes" open>
      <summary>
        <h2>Local notes{state.loaded ? ` · ${open.length} open` : ""}</h2>
      </summary>
      <div className="notes-content">
        <p className="meta">
          Saved in this browser profile for your connected account. Never posted
          to GitHub.
        </p>
        {!state.available ? (
          <p className="notice">
            {checking
              ? "Checking the saved connection…"
              : "Connect or reconnect the same GitHub account to access its local notes. Notes remain stored when disconnected."}
          </p>
        ) : (
          <>
            <div className="controls mt-2">
              <button
                type="button"
                disabled={state.busy || state.loading}
                onClick={() => void session.load()}
              >
                Reload notes
              </button>
            </div>
            <p role="status" className="meta mt-2">
              {state.busy
                ? "Saving notes…"
                : state.loading
                  ? "Loading local notes…"
                  : state.notice}
            </p>
            {state.error && (
              <p className="notice" role="alert">
                {notesErrors[state.error]}
              </p>
            )}
            {state.draft && (
              <form
                className="note-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  session.add();
                }}
              >
                <label htmlFor={newId}>New local note</label>
                <textarea
                  id={newId}
                  value={state.draft.create.text}
                  maxLength={NOTE_TEXT_LIMIT}
                  rows={3}
                  disabled={state.busy}
                  onChange={(event) => session.setNewText(event.target.value)}
                />
                <p className="meta">
                  {state.draft.create.text.length.toLocaleString()} / 10,000
                  characters
                </p>
                <button
                  type="submit"
                  disabled={disabled || !state.draft.create.text.trim()}
                >
                  Add note
                </button>
              </form>
            )}
            {edit && (
              <form
                className="note-form note-editor"
                onSubmit={(event) => {
                  event.preventDefault();
                  session.saveEdit();
                }}
              >
                <label htmlFor={editId}>Edit local note</label>
                <textarea
                  id={editId}
                  value={edit.text}
                  maxLength={NOTE_TEXT_LIMIT}
                  rows={4}
                  disabled={state.busy}
                  onChange={(event) => session.setEditText(event.target.value)}
                />
                {conflict && (
                  <div className="notice">
                    <p>
                      {latest
                        ? "Changed in another tab. Your draft is kept. Choose a version before saving."
                        : "Deleted in another tab. Your draft is kept."}
                    </p>
                    {latest ? (
                      <>
                        <p className="comment-body">
                          Latest saved text: {latest.text}
                        </p>
                        <button
                          type="button"
                          disabled={disabled}
                          onClick={() => session.useLatest(false)}
                        >
                          Use latest
                        </button>{" "}
                        <button
                          type="button"
                          disabled={disabled}
                          onClick={() => session.useLatest(true)}
                        >
                          Keep my draft
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        disabled={disabled || !!state.draft?.create.text.trim()}
                        onClick={() => session.copyEditToNew()}
                      >
                        Copy draft to new note
                      </button>
                    )}
                  </div>
                )}
                <div className="controls">
                  <button
                    type="submit"
                    disabled={disabled || conflict || !edit.text.trim()}
                  >
                    Save
                  </button>
                  <button
                    type="button"
                    disabled={state.busy}
                    onClick={() => session.cancelEdit()}
                  >
                    Cancel editing
                  </button>
                </div>
              </form>
            )}
            <p className="meta mt-2">
              Drafts stay in this tab during GitHub navigation without a page
              reload. Reloading, closing the tab, or connection changes discard
              unsaved text.
            </p>
            {state.loaded && !state.notes.length && (
              <p className="meta mt-2">No saved local notes for this PR.</p>
            )}
            <ul className="notes-list" aria-label="Open local notes">
              {open.map(row)}
            </ul>
            {!!done.length && (
              <details className="completed-notes">
                <summary>Completed notes · {done.length}</summary>
                <ul className="notes-list" aria-label="Completed local notes">
                  {done.map(row)}
                </ul>
              </details>
            )}
          </>
        )}
      </div>
    </details>
  );
}
