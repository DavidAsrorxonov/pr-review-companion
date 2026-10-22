import { createRoot } from 'react-dom/client';
import { Panel } from '../panel/Panel';
import { createPanelSession } from '../panel/session';
import { panelTransport } from './panelTransport';
import type { PrIdentity } from '../shared/reviews';
import css from '../styles/panel.css?inline';
import { HOST_ID, mountingParent, removeOrphanHost } from './domAnchors';

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
  root.render(<Panel session={session} />);
  function restore() {
    const parent = mountingParent();
    if (parent && !host.isConnected) { removeOrphanHost(host); parent.append(host); }
  }
  restore();
  return { restore, revalidate: session.revalidate, suspend: session.suspend,
    destroy() { session.dispose(); root.unmount(); host.remove(); },
  };
}
