import { parsePrUrl } from '../../shared/reviews';
import type { PrIdentity } from '../../shared/reviews';
import { AuthFailure } from '../auth/errors';

export type PageSender = Pick<chrome.runtime.MessageSender, 'id' | 'url' | 'origin' | 'frameId' | 'documentId' | 'documentLifecycle'>
  & { tab?: { id?: number } };
export type Caller = { key: string; documentId: string; tabId?: number; kind: 'options' | 'content' };
export type GetTab = (id: number) => Promise<{ url?: string; pendingUrl?: string; discarded?: boolean }>;
export const samePr = (a: PrIdentity | null, b: PrIdentity | null) => !!a && !!b
  && a.owner === b.owner && a.repo === b.repo && a.number === b.number;

export function identifyCaller(sender: PageSender, extensionId: string): Caller {
  if (sender.id !== extensionId || !sender.documentId) throw new AuthFailure('FORBIDDEN_CALLER');
  const origin = `chrome-extension://${extensionId}`;
  if (sender.url === `${origin}/src/options/options.html`
    && (sender.origin === undefined || sender.origin === origin)
    && (sender.frameId === undefined || sender.frameId === 0)) {
    return { kind: 'options', documentId: sender.documentId, key: `options:${sender.documentId}` };
  }
  let url: URL;
  try { url = new URL(sender.url ?? ''); } catch { throw new AuthFailure('FORBIDDEN_CALLER'); }
  if (url.origin !== 'https://github.com' || url.username || url.password || sender.origin !== 'https://github.com'
    || sender.frameId !== 0 || sender.documentLifecycle !== 'active'
    || !Number.isInteger(sender.tab?.id) || sender.tab!.id! < 0) throw new AuthFailure('FORBIDDEN_CALLER');
  return { kind: 'content', documentId: sender.documentId, tabId: sender.tab!.id!,
    key: `content:${sender.tab!.id}:${sender.documentId}` };
}

export async function checkCurrentPr(caller: Caller, pr: PrIdentity, getTab?: GetTab) {
  if (caller.kind === 'options') return;
  if (!getTab || caller.tabId === undefined) throw new AuthFailure('FORBIDDEN_CALLER');
  try {
    const tab = await getTab(caller.tabId);
    if (tab.discarded || !samePr(parsePrUrl(tab.url ?? ''), pr)
      || (tab.pendingUrl !== undefined && !samePr(parsePrUrl(tab.pendingUrl), pr))) throw new Error();
  } catch { throw new AuthFailure('FORBIDDEN_CALLER'); }
}
