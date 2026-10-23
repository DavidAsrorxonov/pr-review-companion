import { notesRequestSchema, notesErrorSchema, type NotesReply } from '../../shared/notes';
import type { PrIdentity } from '../../shared/reviews';
import type { AuthStorage, LocalAccountAccess } from '../auth/controller';
import { AuthFailure } from '../auth/errors';
import { checkCurrentPr, identifyCaller, type GetTab, type PageSender } from '../panel/access';
import { NotesFailure, operateNotes } from './store';

export function createNotesController(deps: {
  account: LocalAccountAccess; storage: Pick<AuthStorage, 'get' | 'set'>; extensionId: string; getTab: GetTab;
  changed(pr: PrIdentity): Promise<unknown>; now?: () => number;
}) {
  return {
    async handle(raw: unknown, sender: PageSender): Promise<NotesReply> {
      try {
        const caller = identifyCaller(sender, deps.extensionId);
        if (caller.kind !== 'content') throw new NotesFailure('FORBIDDEN_CALLER');
        const parsed = notesRequestSchema.safeParse(raw);
        if (!parsed.success) throw new NotesFailure('INVALID_REQUEST');
        const request = parsed.data;
        const check = () => checkCurrentPr(caller, request.pr, deps.getTab);
        await check();
        const notes = await deps.account.run(request.revision, async accountId => {
          await check();
          return operateNotes(deps.storage, accountId, request, check, deps.now);
        });
        // A saved mutation remains saved even if navigation prevents its reply.
        if (request.type !== 'notes.list') void deps.changed(request.pr).catch(() => undefined);
        return await deps.account.run(request.revision, async () => {
          await check();
          return { ok: true, pr: request.pr, revision: request.revision, notes };
        });
      } catch (error) {
        const code = error instanceof NotesFailure || error instanceof AuthFailure ? notesErrorSchema.safeParse(error.code) : null;
        return { ok: false, error: { code: code?.success ? code.data : 'STORAGE' } };
      }
    },
  };
}
