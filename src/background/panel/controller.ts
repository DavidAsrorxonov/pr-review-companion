import { panelRequestSchema } from '../../shared/panel';
import type { PanelReply, PanelStatus } from '../../shared/panel';
import type { CredentialAccess } from '../auth/controller';
import { AuthFailure } from '../auth/errors';
import { safeReviewError } from '../reviews/errors';
import { checkCurrentPr, identifyCaller } from './access';
import type { GetTab, PageSender } from './access';

export function createPanelController(deps: {
  credentials: CredentialAccess; extensionId: string; getTab: GetTab; openSettings: () => Promise<void>;
}) {
  return {
    async handle(raw: unknown, sender: PageSender): Promise<PanelReply> {
      try {
        const caller = identifyCaller(sender, deps.extensionId);
        if (caller.kind !== 'content') throw new AuthFailure('FORBIDDEN_CALLER');
        const parsed = panelRequestSchema.safeParse(raw);
        if (!parsed.success) throw new AuthFailure('INVALID_REQUEST');
        await checkCurrentPr(caller, parsed.data.pr, deps.getTab);
        const status: PanelStatus = await deps.credentials.panelStatus();
        if (parsed.data.type === 'panel.openSettings') await deps.openSettings();
        await checkCurrentPr(caller, parsed.data.pr, deps.getTab);
        return { ok: true, status };
      } catch (error) { return { ok: false, error: safeReviewError(error) }; }
    },
  };
}
