import { createRoot } from 'react-dom/client';
import { Panel } from '../panel/Panel';
import { createPanelSession } from '../panel/session';
import { panelTransport } from './panelTransport';
import type { PrIdentity } from '../shared/reviews';
import css from '../styles/panel.css?inline';
import { HOST_ID, mountingParent, removeOrphanHost, findDiscussion, observeDiscussions, highlightDiscussion } from './domAnchors';
import { createThreadJump } from './threadJump';
import { createNotesSession } from '../panel/notesSession';
import { requestNotes } from '../shared/notes';
import { noteDrafts } from './noteDrafts';

export function mountPanel(pr: PrIdentity, isCurrent: () => boolean) {
  const host = document.createElement('div');
  host.id = HOST_ID;
  // Host layout is the only light-DOM styling. No GitHub element is restyled.
  host.style.cssText = 'all:initial!important;position:fixed!important;inset:0!important;width:0!important;height:0!important;z-index:2147483000!important;';
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style'); style.textContent = css; shadow.append(style);
  const container = document.createElement('div'); container.className = 'prrc-root'; shadow.append(container);
  const root = createRoot(container);
  const session = createPanelSession(pr, panelTransport, isCurrent);
  const notes = createNotesSession(pr, requestNotes, noteDrafts, isCurrent);
  const stopNotes = session.subscribe(() => notes.sync(session.getSnapshot()));
  let jumpUrl = location.href;
  let revealing = false;
  const jump = createThreadJump({
    valid(revision) {
      const state = session.getSnapshot();
      return isCurrent() && location.href === jumpUrl && !state.checking && !!state.status?.connected
        && state.status.health !== 'invalid' && state.status.revision === revision
        && (revealing || state.open && state.reply?.revision === revision && !!(state.reply.snapshot || state.reply.partial));
    },
    find: findDiscussion, observe: observeDiscussions,
    collapse() { revealing = true; session.close(); },
    reveal: (target, valid, finish) => highlightDiscussion(shadow, target, valid, finish),
  });
  const jumpApi = { ...jump, jump: (links: Parameters<typeof jump.jump>[0], revision: string) => {
    jumpUrl = location.href;
    revealing = false;
    const state = session.getSnapshot();
    if (!state.open || state.reply?.revision !== revision) return Promise.resolve({ state: 'cancelled' as const });
    return jump.jump(links, revision);
  } };
  root.render(<Panel session={session} jump={jumpApi} pr={pr} notes={notes} />);
  function restore() {
    const parent = mountingParent();
    if (parent && !host.isConnected) { removeOrphanHost(host); parent.append(host); }
  }
  restore();
  return { restore, navigated: jump.cancel, notesChanged: notes.invalidate,
    revalidate(clear = false) { jump.cancel(); return session.revalidate(clear); },
    suspend() { jump.cancel(); session.suspend(); },
    destroy() { stopNotes(); notes.dispose(); jump.dispose(); session.dispose(); root.unmount(); host.remove(); },
  };
}
