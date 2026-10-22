import type { DiscussionLink } from '../shared/threadLinks';

// All page/host selectors live here. Exact discussion_r IDs were checked on
// microsoft/vscode#274; unsupported GitHub layouts fall back to the permalink.
export const HOST_ID = 'pr-review-companion-host';
export function mountingParent() { return document.body; }
export function removeOrphanHost(owned: HTMLElement) {
  const existing = document.getElementById(HOST_ID);
  if (existing && existing !== owned) existing.remove();
}

export function findDiscussion(links: DiscussionLink[]): HTMLElement | null {
  for (const link of links) {
    const target = document.getElementById(link.fragment);
    if (!(target instanceof HTMLElement) || target.closest('[inert], [hidden]')) continue;
    const opened: HTMLDetailsElement[] = [];
    for (let ancestor = target.parentElement; ancestor; ancestor = ancestor.parentElement) {
      if (ancestor instanceof HTMLDetailsElement && !ancestor.open) { opened.push(ancestor); ancestor.open = true; }
    }
    const rect = target.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0 && target.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return target;
    opened.forEach(details => { details.open = false; });
  }
  return null;
}

export function observeDiscussions(check: () => void) {
  let stopped = false;
  const observe = () => observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true,
    attributeFilter: ['id', 'hidden', 'open', 'class', 'style'] });
  const observer = new MutationObserver(() => {
    observer.disconnect(); check();
    // Native disclosure inspection must not observe its own open/restore mutations.
    if (!stopped) observe();
  });
  observe();
  return () => { stopped = true; observer.disconnect(); };
}

function stickyHeaderBottom() {
  let bottom = 0;
  for (const node of document.querySelectorAll('header, [role="banner"], .js-sticky, .position-sticky')) {
    const position = getComputedStyle(node).position;
    const rect = node.getBoundingClientRect();
    if ((position === 'sticky' || position === 'fixed') && rect.top <= 0 && rect.bottom < innerHeight / 2) bottom = Math.max(bottom, rect.bottom);
  }
  return bottom;
}

export function highlightDiscussion(shadow: ShadowRoot, target: HTMLElement, valid: () => boolean, finish: () => void) {
  const overlay = document.createElement('div'); overlay.className = 'jump-highlight'; overlay.setAttribute('aria-hidden', 'true');
  shadow.append(overlay);
  const oldTabIndex = target.getAttribute('tabindex');
  if (oldTabIndex === null) target.setAttribute('tabindex', '-1');
  const restoreFocusAttribute = () => {
    if (oldTabIndex === null && target.getAttribute('tabindex') === '-1') target.removeAttribute('tabindex');
  };
  target.addEventListener('blur', restoreFocusAttribute, { once: true });
  target.focus({ preventScroll: true });
  const behavior = matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth';
  target.scrollIntoView({ block: 'center', inline: 'nearest', behavior });
  let frame = 0; let previousTop = NaN; let stable = 0; let adjusted = false;
  const startedAt = performance.now();
  function position() {
    if (!valid() || !target.isConnected || !target.checkVisibility({ opacityProperty: true, visibilityProperty: true })) { finish(); return; }
    const rect = target.getBoundingClientRect();
    stable = Math.abs(previousTop - rect.top) < .5 ? stable + 1 : 0; previousTop = rect.top;
    // After scrolling settles, keep the first line below fixed/sticky headers,
    // including comments taller than the viewport. Never restyle the page.
    if (stable >= 3 && !adjusted && performance.now() - startedAt >= 300 && rect.top < innerHeight && rect.bottom > 0) {
      adjusted = true; const top = stickyHeaderBottom() + 12;
      if (rect.top < top) window.scrollBy({ top: rect.top - top, behavior: 'instant' });
    }
    overlay.style.left = `${rect.left}px`; overlay.style.top = `${rect.top}px`;
    overlay.style.width = `${rect.width}px`; overlay.style.height = `${rect.height}px`;
    frame = requestAnimationFrame(position);
  }
  frame = requestAnimationFrame(position);
  const timeout = setTimeout(finish, 2500);
  return () => {
    cancelAnimationFrame(frame); clearTimeout(timeout); overlay.remove();
    target.removeEventListener('blur', restoreFocusAttribute); restoreFocusAttribute();
  };
}

// If an extension reload removes an old content-script chunk, offer recovery
// without throwing an unhandled import error or installing a duplicate panel.
export function mountUnavailable() {
  const host = document.createElement('div'); host.id = HOST_ID;
  host.style.cssText = 'position:fixed;bottom:16px;right:16px;z-index:2147483000';
  const shadow = host.attachShadow({ mode: 'open' });
  const button = document.createElement('button');
  button.textContent = 'Review Companion unavailable — reload tab';
  button.style.cssText = 'font:14px system-ui;padding:12px;background:white;color:#172b29;border:1px solid #dce5de;border-radius:8px;cursor:pointer';
  button.addEventListener('click', () => location.reload()); shadow.append(button);
  function restore() { if (!host.isConnected) { removeOrphanHost(host); mountingParent()?.append(host); } }
  restore();
  return { restore, destroy() { host.remove(); }, async revalidate() {}, suspend() {} };
}
