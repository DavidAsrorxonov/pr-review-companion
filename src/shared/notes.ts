import { z } from "zod";
import { prIdentitySchema } from "./reviews";

export const NOTE_LIMIT = 200;
export const NOTE_TEXT_LIMIT = 10_000;
export const NOTES_BYTES_LIMIT = 2 * 1024 * 1024;
const textSchema = z
  .string()
  .max(NOTE_TEXT_LIMIT)
  .refine((text) => text.trim().length > 0);
const versionSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const noteSchema = z
  .object({
    id: z.string().uuid(),
    text: textSchema,
    done: z.boolean(),
    version: versionSchema,
    createdAt: z.number().finite().nonnegative(),
    updatedAt: z.number().finite().nonnegative(),
  })
  .strict();
export type Note = z.infer<typeof noteSchema>;
const scope = { pr: prIdentitySchema, revision: z.string().uuid() };
export const notesRequestSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("notes.list"), ...scope }).strict(),
  z
    .object({
      type: z.literal("notes.create"),
      ...scope,
      id: z.string().uuid(),
      text: textSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("notes.update"),
      ...scope,
      id: z.string().uuid(),
      expectedVersion: versionSchema,
      text: textSchema.optional(),
      done: z.boolean().optional(),
    })
    .strict()
    .refine((value) => value.text !== undefined || value.done !== undefined),
  z
    .object({
      type: z.literal("notes.delete"),
      ...scope,
      id: z.string().uuid(),
      expectedVersion: versionSchema,
    })
    .strict(),
]);
export type NotesRequest = z.infer<typeof notesRequestSchema>;
export const notesErrorSchema = z.enum([
  "INVALID_REQUEST",
  "FORBIDDEN_CALLER",
  "NOT_CONNECTED",
  "SUPERSEDED",
  "STORAGE",
  "CORRUPT",
  "CAPACITY",
  "CONFLICT",
  "NOT_FOUND",
  "WORKER_UNAVAILABLE",
  "UNEXPECTED_RESPONSE",
]);
export type NotesErrorCode = z.infer<typeof notesErrorSchema>;
export const notesReplySchema = z.discriminatedUnion("ok", [
  z
    .object({
      ok: z.literal(true),
      pr: prIdentitySchema,
      revision: z.string().uuid(),
      notes: z.array(noteSchema).max(NOTE_LIMIT),
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      error: z.object({ code: notesErrorSchema }).strict(),
    })
    .strict(),
]);
export type NotesReply = z.infer<typeof notesReplySchema>;
export const notesErrors: Record<NotesErrorCode, string> = {
  INVALID_REQUEST: "Enter a nonempty note of at most 10,000 characters.",
  FORBIDDEN_CALLER:
    "Notes are only available for the PR currently open in this tab.",
  NOT_CONNECTED:
    "Reconnect the same GitHub account to access its saved local notes.",
  SUPERSEDED: "The connection changed. Reopen the drawer to load its notes.",
  STORAGE:
    "The notes operation could not be confirmed. Your draft is kept. Reload notes before retrying.",
  CORRUPT: "Saved notes could not be read. They have not been overwritten.",
  CAPACITY:
    "Local notes are full (200 per PR or 2 MiB total). Delete unwanted saved notes and retry.",
  CONFLICT:
    "This note changed in another tab. Your draft is kept; review the latest version before saving.",
  NOT_FOUND: "This note was deleted in another tab. Your draft is kept.",
  WORKER_UNAVAILABLE:
    "The notes operation could not be confirmed. Reload notes before retrying. Reload this tab if the extension was reloaded.",
  UNEXPECTED_RESPONSE:
    "The notes response could not be verified. Reload notes before retrying.",
};
export async function requestNotes(request: NotesRequest): Promise<NotesReply> {
  try {
    const parsed = notesReplySchema.safeParse(
      await chrome.runtime.sendMessage(request),
    );
    return parsed.success
      ? parsed.data
      : { ok: false, error: { code: "UNEXPECTED_RESPONSE" } };
  } catch {
    return { ok: false, error: { code: "WORKER_UNAVAILABLE" } };
  }
}
