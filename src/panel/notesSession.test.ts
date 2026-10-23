import { describe, expect, it, vi } from "vitest";
import { createNotesSession } from "./notesSession";
import { createNoteDraftStore } from "../content/noteDrafts";
import type { PanelView } from "./session";
import type { Note, NotesReply, NotesRequest } from "../shared/notes";
import {
  deferred,
  identity,
} from "../background/reviews/fixtures.test-support";

const revision = "00000000-0000-4000-8000-000000000001";
const panel: PanelView = {
  open: true,
  busy: false,
  checking: false,
  status: { connected: true, health: "verified", revision },
};
const note: Note = {
  id: crypto.randomUUID(),
  text: "Saved text",
  done: false,
  version: 1,
  createdAt: 1,
  updatedAt: 1,
};
const reply = (notes: Note[] = []): NotesReply => ({
  ok: true,
  pr: identity,
  revision,
  notes,
});
function fixture() {
  const drafts = createNoteDraftStore();
  const send = vi
    .fn<(request: NotesRequest) => Promise<NotesReply>>()
    .mockResolvedValue(reply());
  let current = true;
  const session = createNotesSession(identity, send, drafts, () => current);
  const ready = async () => {
    session.sync(panel);
    await vi.waitFor(() => expect(session.getSnapshot().loaded).toBe(true));
  };
  return {
    drafts,
    send,
    session,
    ready,
    leave: () => {
      current = false;
    },
  };
}
describe("notes UI lifecycle", () => {
  it("reads only when open with a saved account; health does not block local notes", async () => {
    const s = fixture();
    s.session.sync({ ...panel, open: false });
    expect(s.send).not.toHaveBeenCalled();
    s.session.sync({ ...panel, status: { connected: false } });
    expect(s.send).not.toHaveBeenCalled();
    s.session.sync({
      ...panel,
      status: { connected: true, health: "invalid", revision },
    });
    await vi.waitFor(() => expect(s.session.getSnapshot().loaded).toBe(true));
    expect(s.send).toHaveBeenCalledWith({
      type: "notes.list",
      pr: identity,
      revision,
    });
    s.session.sync({ ...panel, busy: true });
    expect(s.send).toHaveBeenCalledOnce();
  });
  it("keeps unsaved text through close, suspension and focus revalidation", async () => {
    const s = fixture();
    await s.ready();
    s.session.setNewText("Draft");
    s.session.sync({ ...panel, open: false });
    expect(s.session.getSnapshot().notes).toEqual([]);
    await s.ready();
    expect(s.session.getSnapshot().draft?.create.text).toBe("Draft");
    s.session.sync({ ...panel, checking: true });
    expect(s.session.getSnapshot().draft).toBeUndefined();
    await s.ready();
    expect(s.session.getSnapshot().draft?.create.text).toBe("Draft");
  });
  it("preserves per-PR drafts across mounts within the same document", async () => {
    const s = fixture();
    await s.ready();
    s.session.setNewText("PR one");
    s.session.dispose();
    const other = createNotesSession(
      { ...identity, number: 124 },
      s.send,
      s.drafts,
      () => true,
    );
    other.sync(panel);
    other.setNewText("PR two");
    other.dispose();
    const back = createNotesSession(identity, s.send, s.drafts, () => true);
    back.sync(panel);
    expect(back.getSnapshot().draft?.create.text).toBe("PR one");
  });
  it("discards drafts on explicit invalidation or a changed connection revision", async () => {
    const s = fixture();
    await s.ready();
    s.session.setNewText("Private draft");
    s.drafts.clear();
    s.session.sync({ ...panel, checking: true });
    await s.ready();
    expect(s.session.getSnapshot().draft?.create.text).toBe("");
    s.session.setNewText("Old account");
    s.session.sync({
      ...panel,
      status: {
        connected: true,
        health: "verified",
        revision: crypto.randomUUID(),
      },
    });
    expect(s.session.getSnapshot().draft?.create.text).toBe("");
  });
  it.each(["navigation", "close", "dispose", "connection"])(
    "rejects stale responses after %s",
    async (event) => {
      const s = fixture();
      const gate = deferred<NotesReply>();
      s.send.mockReturnValueOnce(gate.promise);
      s.session.sync(panel);
      if (event === "navigation") s.leave();
      if (event === "close") s.session.sync({ ...panel, open: false });
      if (event === "dispose") s.session.dispose();
      if (event === "connection")
        s.session.sync({ ...panel, checking: true, status: null });
      gate.resolve(reply([note]));
      await Promise.resolve();
      await Promise.resolve();
      expect(s.session.getSnapshot().notes).toEqual([]);
    },
  );
  it("rejects mismatched PR and connection replies", async () => {
    for (const response of [
      { ...reply([note]), pr: { ...identity, number: 124 } },
      { ...reply([note]), revision: crypto.randomUUID() },
    ]) {
      const s = fixture();
      s.send.mockResolvedValue(response);
      s.session.sync(panel);
      await vi.waitFor(() =>
        expect(s.session.getSnapshot().error).toBe("SUPERSEDED"),
      );
      expect(s.session.getSnapshot().notes).toEqual([]);
    }
  });
  it.each(["NOT_CONNECTED", "SUPERSEDED"] as const)(
    "suppresses notes/drafts on %s even if an invalidation broadcast was missed",
    async (code) => {
      const s = fixture();
      s.send.mockResolvedValue(reply([note]));
      await s.ready();
      s.session.setNewText("Private draft");
      s.send.mockResolvedValue({ ok: false, error: { code } });
      await s.session.load();
      expect(s.session.getSnapshot().notes).toEqual([]);
      expect(s.session.getSnapshot().draft).toBeUndefined();
      expect(s.drafts.get("other", revision).create.text).toBe("");
    },
  );
  it("does not claim saving or clear text before storage acknowledgement", async () => {
    const s = fixture();
    await s.ready();
    s.session.setNewText("New text");
    const id = s.session.getSnapshot().draft!.create.id;
    const gate = deferred<NotesReply>();
    s.send.mockReturnValueOnce(gate.promise);
    s.session.add();
    expect(s.session.getSnapshot().busy).toBe(true);
    expect(s.session.getSnapshot().draft?.create.text).toBe("New text");
    gate.resolve(reply([{ ...note, id, text: "New text" }]));
    await vi.waitFor(() =>
      expect(s.session.getSnapshot().notice).toBe("Note saved locally."),
    );
    expect(s.session.getSnapshot().draft?.create.text).toBe("");
    expect(s.session.getSnapshot().notes).toHaveLength(1);
  });
  it("retains text after failed writes and reconciles before retrying", async () => {
    const s = fixture();
    await s.ready();
    s.session.setNewText("Still unsaved");
    const id = s.session.getSnapshot().draft!.create.id;
    s.send.mockResolvedValueOnce({ ok: false, error: { code: "CAPACITY" } });
    s.session.add();
    await vi.waitFor(() => expect(s.send).toHaveBeenCalledTimes(3));
    expect(s.session.getSnapshot().draft?.create).toEqual({
      id,
      text: "Still unsaved",
    });
    expect(s.session.getSnapshot().error).toBe("CAPACITY");
    expect(s.send.mock.calls[2]?.[0].type).toBe("notes.list");
  });
  it("recognizes an already-saved create after a lost acknowledgement", async () => {
    const s = fixture();
    await s.ready();
    s.session.setNewText("Already saved");
    const id = s.session.getSnapshot().draft!.create.id;
    s.send
      .mockResolvedValueOnce({
        ok: false,
        error: { code: "WORKER_UNAVAILABLE" },
      })
      .mockResolvedValueOnce(reply([{ ...note, id, text: "Already saved" }]));
    s.session.add();
    await vi.waitFor(() =>
      expect(s.session.getSnapshot().draft?.create.text).toBe(""),
    );
    expect(s.session.getSnapshot().notes).toHaveLength(1);
    expect(
      s.send.mock.calls.filter(([request]) => request.type === "notes.create"),
    ).toHaveLength(1);
  });
  it("blocks retry until an uncertain write can be reconciled", async () => {
    const s = fixture();
    await s.ready();
    s.session.setNewText("Uncertain");
    s.send.mockResolvedValue({ ok: false, error: { code: "STORAGE" } });
    s.session.add();
    await vi.waitFor(() => expect(s.session.getSnapshot().loading).toBe(false));
    await vi.waitFor(() => expect(s.send).toHaveBeenCalledTimes(3));
    s.session.add();
    expect(s.send).toHaveBeenCalledTimes(3);
    expect(s.session.getSnapshot().reconcile).toBe(true);
  });
  it("preserves dirty edits on cross-tab updates and requires explicit conflict resolution", async () => {
    const s = fixture();
    s.send.mockResolvedValue(reply([note]));
    await s.ready();
    s.session.edit(note);
    s.session.setEditText("My draft");
    const latest = { ...note, text: "Other tab", version: 2 };
    s.send.mockResolvedValue(reply([latest]));
    await s.session.load();
    expect(s.session.getSnapshot().draft?.edit).toMatchObject({
      text: "My draft",
      version: 1,
    });
    s.session.useLatest(true);
    expect(s.session.getSnapshot().draft?.edit).toMatchObject({
      text: "My draft",
      version: 2,
    });
    s.session.useLatest(false);
    expect(s.session.getSnapshot().draft?.edit?.text).toBe("Other tab");
  });
  it("keeps deleted-note drafts and can copy them to a new note without replacing another draft", async () => {
    const s = fixture();
    s.send.mockResolvedValue(reply([note]));
    await s.ready();
    s.session.edit(note);
    s.session.setEditText("Deleted draft");
    s.send.mockResolvedValue(reply());
    await s.session.load();
    s.session.setNewText("Other draft");
    s.session.copyEditToNew();
    expect(s.session.getSnapshot().draft?.create.text).toBe("Other draft");
    s.session.setNewText("");
    s.session.copyEditToNew();
    expect(s.session.getSnapshot().draft?.create.text).toBe("Deleted draft");
    expect(s.session.getSnapshot().draft?.edit).toBeUndefined();
  });
  it("queues invalidation reads behind a mutation rather than discarding its acknowledgement", async () => {
    const s = fixture();
    await s.ready();
    s.session.setNewText("Pending");
    const id = s.session.getSnapshot().draft!.create.id;
    const gate = deferred<NotesReply>();
    s.send.mockReturnValueOnce(gate.promise);
    s.session.add();
    s.session.invalidate();
    expect(s.send).toHaveBeenCalledTimes(2);
    s.send.mockResolvedValue(reply([{ ...note, id, text: "Pending" }]));
    gate.resolve(reply([{ ...note, id, text: "Pending" }]));
    await vi.waitFor(() => expect(s.send).toHaveBeenCalledTimes(3));
    expect(s.session.getSnapshot().draft?.create.text).toBe("");
    expect(s.session.getSnapshot().notes).toHaveLength(1);
  });
});
