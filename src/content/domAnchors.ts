// All page/host selectors live here. The panel needs no GitHub layout internals.
export const HOST_ID = 'pr-review-companion-host';
export function mountingParent() { return document.body; }
export function removeOrphanHost(owned: HTMLElement) {
  const existing = document.getElementById(HOST_ID);
  if (existing && existing !== owned) existing.remove();
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
