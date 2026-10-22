import { z } from 'zod';
import { prIdentitySchema, reviewErrorSchema } from './reviews';

export const panelStatusSchema = z.discriminatedUnion('connected', [
  z.object({ connected: z.literal(false) }).strict(),
  z.object({ connected: z.literal(true), health: z.enum(['verified', 'unknown', 'invalid']), revision: z.string().uuid() }).strict(),
]);
export type PanelStatus = z.infer<typeof panelStatusSchema>;
export const panelRequestSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('panel.status'), pr: prIdentitySchema }).strict(),
  z.object({ type: z.literal('panel.openSettings'), pr: prIdentitySchema }).strict(),
]);
export type PanelRequest = z.infer<typeof panelRequestSchema>;
const panelReplySchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), status: panelStatusSchema }).strict(),
  z.object({ ok: z.literal(false), error: reviewErrorSchema }).strict(),
]);
export type PanelReply = z.infer<typeof panelReplySchema>;
export async function requestPanel(request: PanelRequest): Promise<PanelReply> {
  try {
    const parsed = panelReplySchema.safeParse(await chrome.runtime.sendMessage(request));
    return parsed.success ? parsed.data : { ok: false, error: { code: 'UNEXPECTED_RESPONSE' } };
  } catch { return { ok: false, error: { code: 'WORKER_UNAVAILABLE' } }; }
}
