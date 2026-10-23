// Production extension checks using synthetic credentials and controlled APIs.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = resolve(import.meta.dirname, '../..'); const artifacts = join(root, 'test-results/step6');
await mkdir(artifacts, { recursive: true });
const context = await chromium.launchPersistentContext(await mkdtemp(join(tmpdir(), 'prrc-notes-')), {
  executablePath: process.env.CHROME_EXECUTABLE || undefined, headless: true, viewport: { width: 1280, height: 800 },
  args: [`--disable-extensions-except=${root}/dist`, `--load-extension=${root}/dist`],
});
const errors = []; context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
let requests = 0; let invalid = false;
await context.route('https://api.github.com/**', route => {
  requests++; const request = route.request();
  assert.match(request.headers().authorization, /^Bearer github_pat_notes_fixture_/);
  if (new URL(request.url()).pathname === '/user') return route.fulfill(invalid ? { status: 401, json: { message: 'Invalid' } }
    : { json: { id: request.headers().authorization.endsWith('_second') ? 99 : 42, login: request.headers().authorization.endsWith('_second') ? 'second' : 'first' } });
  const number = request.postDataJSON().variables.number;
  return route.fulfill({ json: { data: { repository: { pullRequest: { id: `PR${number}`, number, title: `Notes PR ${number}`,
    url: `https://github.com/fixture/repository/pull/${number}`, state: 'OPEN', isDraft: false,
    reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
  } } } } });
});
const base = 'https://github.com/fixture/repository/pull/123';
await context.route('https://github.com/**', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><style>
body{font:18px Georgia;background:rgb(240,241,242);padding:30px}main{color:rgb(1,2,3)}
</style></head><body><main><h1>GitHub fixture</h1><button id="native">Native control</button></main></body></html>` }));
const host = page => page.locator('#pr-review-companion-host');
const section = page => host(page).locator('.local-notes');
const newText = page => section(page).getByLabel('New local note', { exact: true });
const rows = page => section(page).locator('.local-note');
const row = (page, text) => rows(page).filter({ has: page.getByText(text, { exact: true }) });
async function ready(page) {
  await newText(page).waitFor();
  await page.waitForFunction(() => {
    const notes = document.getElementById('pr-review-companion-host')?.shadowRoot.querySelector('.local-notes');
    return notes && !notes.textContent.includes('Loading local notes…') && !notes.textContent.includes('Saving notes…');
  });
}
async function open(page) {
  await page.bringToFront(); await host(page).getByRole('button', { name: 'Review Companion', exact: true }).click(); await ready(page);
}
async function add(page, text) {
  await ready(page); await newText(page).fill(text); await section(page).getByRole('button', { name: 'Add note', exact: true }).click();
  await row(page, text).waitFor(); await ready(page); assert.equal(await newText(page).inputValue(), '');
}
try {
  let worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker'); const id = new URL(worker.url()).host;
  const options = await context.newPage(); await options.goto(`chrome-extension://${id}/src/options/options.html`);
  async function connect(account = 'first') {
    const replace = options.getByRole('button', { name: 'Replace token', exact: true });
    if (await replace.count()) await replace.click();
    await options.getByLabel('Fine-grained personal access token').fill(`github_pat_notes_fixture_${account}`);
    await options.getByRole('button', { name: 'Verify and save', exact: true }).click();
    await options.getByText(`Saved account: @${account}`, { exact: true }).waitFor();
  }
  await connect(); const page = await context.newPage(); await page.goto(base); await open(page);
  const nativeStyle = await page.locator('main').evaluate(el => [getComputedStyle(el).fontFamily, getComputedStyle(el).color, document.styleSheets.length]);
  const before = requests;
  await newText(page).fill('  \n '); assert.equal(await section(page).getByRole('button', { name: 'Add note', exact: true }).isDisabled(), true);
  const first = '<img src=x onerror=alert(1)>\nCheck edge cases';
  await add(page, first); assert.equal(await section(page).locator('img').count(), 0);
  await add(page, 'Second note'); assert.equal(await rows(page).count(), 2);
  await row(page, first).getByRole('button', { name: 'Edit', exact: true }).click();
  await section(page).getByLabel('Edit local note').fill('Edited first note');
  await section(page).getByRole('button', { name: 'Save', exact: true }).click(); await row(page, 'Edited first note').waitFor();
  await row(page, 'Edited first note').getByRole('checkbox').click();
  await section(page).getByText('Completed notes · 1', { exact: true }).waitFor();
  await section(page).getByText('Completed notes · 1', { exact: true }).click();
  await row(page, 'Edited first note').getByRole('checkbox').click(); await ready(page);
  await row(page, 'Second note').getByRole('button', { name: 'Delete', exact: true }).click();
  await section(page).getByRole('button', { name: 'Keep note', exact: true }).click(); assert.equal(await rows(page).count(), 2);
  await row(page, 'Second note').getByRole('button', { name: 'Delete', exact: true }).click();
  await section(page).getByRole('button', { name: 'Confirm delete', exact: true }).click(); await row(page, 'Second note').waitFor({ state: 'detached' });
  assert.equal(requests, before);
  console.log('PASS explicit create/edit/done/delete, safe text, count/grouping, no notes API traffic');

  await newText(page).fill('PR 123 draft');
  await host(page).getByRole('button', { name: 'Close', exact: true }).click(); await open(page);
  assert.equal(await newText(page).inputValue(), 'PR 123 draft');
  await page.evaluate(() => history.pushState({}, '', '/fixture/repository/pull/123/files')); await ready(page);
  assert.equal(await newText(page).inputValue(), 'PR 123 draft');
  await page.evaluate(() => history.pushState({}, '', '/fixture/repository/pull/124'));
  await host(page).locator('aside').waitFor({ state: 'detached' }); await open(page); await newText(page).fill('PR 124 draft');
  await page.evaluate(() => history.pushState({}, '', '/fixture/repository/pull/123'));
  await host(page).locator('aside').waitFor({ state: 'detached' }); await open(page);
  assert.equal(await newText(page).inputValue(), 'PR 123 draft');
  await page.reload(); await open(page); assert.equal(await newText(page).inputValue(), ''); await row(page, 'Edited first note').waitFor();
  console.log('PASS same-document per-PR drafts survive closing/subpages/PR transitions; full reload clears drafts, retains saved notes');

  // Real browser storage rejection, injected only into this synthetic test worker.
  await worker.evaluate(() => {
    const original = chrome.storage.local.set.bind(chrome.storage.local);
    chrome.storage.local.set = async items => { if ('prrc.notes.v1' in items) { chrome.storage.local.set = original; throw Error('Controlled write failure'); } return original(items); };
  });
  await newText(page).fill('Retained after failed save'); await section(page).getByRole('button', { name: 'Add note', exact: true }).click();
  await section(page).getByRole('alert').waitFor(); await ready(page);
  assert.equal(await newText(page).inputValue(), 'Retained after failed save'); assert.equal(await rows(page).count(), 1);
  await section(page).getByRole('button', { name: 'Add note', exact: true }).click(); await row(page, 'Retained after failed save').waitFor();
  const browserCdp = await context.browser().newBrowserCDPSession(); const targets = await browserCdp.send('Target.getTargets');
  const target = targets.targetInfos.find(t => t.type === 'service_worker' && t.url.startsWith(`chrome-extension://${id}/`));
  await browserCdp.send('Target.closeTarget', { targetId: target.targetId });
  await section(page).getByRole('button', { name: 'Reload notes', exact: true }).click(); await ready(page); await row(page, 'Edited first note').waitFor();
  worker = context.serviceWorkers().find(w => w.url().startsWith(`chrome-extension://${id}/`)) || await context.waitForEvent('serviceworker');
  console.log('PASS failed-save draft retention/retry and worker-restart persistence');

  const second = await context.newPage(); await second.goto(base); await open(second); await row(second, 'Edited first note').waitFor();
  await page.bringToFront(); await ready(page); await row(page, 'Edited first note').getByRole('button', { name: 'Edit', exact: true }).click();
  await section(page).getByLabel('Edit local note').fill('My unsaved edit');
  await second.bringToFront(); await ready(second); await row(second, 'Edited first note').getByRole('button', { name: 'Edit', exact: true }).click();
  await section(second).getByLabel('Edit local note').fill('Saved in second tab');
  await section(second).getByRole('button', { name: 'Save', exact: true }).click(); await row(second, 'Saved in second tab').waitFor();
  await page.bringToFront(); await ready(page); await section(page).getByText(/Changed in another tab/).waitFor();
  assert.equal(await section(page).getByLabel('Edit local note').inputValue(), 'My unsaved edit');
  assert.equal(await section(page).getByRole('button', { name: 'Save', exact: true }).isDisabled(), true);
  await section(page).getByRole('button', { name: 'Keep my draft', exact: true }).click();
  await section(page).getByRole('button', { name: 'Save', exact: true }).click(); await row(page, 'My unsaved edit').waitFor();
  await row(page, 'My unsaved edit').getByRole('button', { name: 'Edit', exact: true }).click(); await section(page).getByLabel('Edit local note').fill('Draft of deleted note');
  await second.bringToFront(); await ready(second); await row(second, 'My unsaved edit').getByRole('button', { name: 'Delete', exact: true }).click();
  await section(second).getByRole('button', { name: 'Confirm delete', exact: true }).click(); await row(second, 'My unsaved edit').waitFor({ state: 'detached' });
  await page.bringToFront(); await ready(page); await section(page).getByText('Deleted in another tab. Your draft is kept.', { exact: true }).waitFor();
  await section(page).getByRole('button', { name: 'Copy draft to new note', exact: true }).click();
  assert.equal(await newText(page).inputValue(), 'Draft of deleted note');
  await section(page).getByRole('button', { name: 'Add note', exact: true }).click(); await row(page, 'Draft of deleted note').waitFor();
  console.log('PASS cross-tab conflicts preserve drafts, explicit rebase, and deleted-note draft recovery');

  const offlineBefore = requests; await context.setOffline(true); await add(page, 'Written offline'); await context.setOffline(false);
  assert.equal(requests, offlineBefore);
  invalid = true; await options.getByRole('button', { name: 'Recheck connection', exact: true }).click();
  await options.getByText(/GitHub rejected this credential/).first().waitFor();
  await page.bringToFront(); await ready(page); const invalidBefore = requests; await add(page, 'Written with expired token'); assert.equal(requests, invalidBefore);
  invalid = false; await connect(); await page.bringToFront(); await ready(page); await row(page, 'Written with expired token').waitFor();
  await newText(page).fill('Clear on account change'); await connect('second'); await page.bringToFront(); await ready(page);
  assert.equal(await rows(page).count(), 0); assert.equal(await newText(page).inputValue(), '');
  await add(page, 'Other account only'); await options.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await page.bringToFront(); await section(page).getByText(/Connect or reconnect the same GitHub account/).waitFor(); assert.equal(await rows(page).count(), 0);
  await connect(); await page.bringToFront(); await ready(page); await row(page, 'Written offline').waitFor(); assert.equal(await row(page, 'Other account only').count(), 0);
  console.log('PASS offline/invalid-token access, same-account replacement, disconnect retention, cross-account isolation');

  const status = await options.evaluate(() => chrome.runtime.sendMessage({ type: 'auth.status' }));
  const denied = await options.evaluate(revision => chrome.runtime.sendMessage({ type: 'notes.list', pr: { owner: 'fixture', repo: 'repository', number: 123 }, revision }), status.status.revision);
  assert.equal(denied.error.code, 'FORBIDDEN_CALLER');
  const cdp = await context.newCDPSession(page); const worlds = []; cdp.on('Runtime.executionContextCreated', ({ context }) => worlds.push(context)); await cdp.send('Runtime.enable');
  const isolated = worlds.find(c => c.origin === `chrome-extension://${id}` || c.name === 'PR Review Companion'); assert.ok(isolated);
  const result = await cdp.send('Runtime.evaluate', { contextId: isolated.id, awaitPromise: true, returnByValue: true,
    expression: `chrome.runtime.sendMessage(${JSON.stringify({ type: 'notes.list', pr: { owner: 'fixture', repo: 'repository', number: 124 }, revision: status.status.revision })})` });
  assert.equal(result.result.value.error.code, 'FORBIDDEN_CALLER');
  const deniedStorage = await cdp.send('Runtime.evaluate', { contextId: isolated.id, awaitPromise: true, returnByValue: true,
    expression: 'chrome.storage.local.get("prrc.notes.v1").then(()=>false,()=>true)' }); assert.equal(deniedStorage.result.value, true);
  await page.setViewportSize({ width: 320, height: 650 }); const bounds = await host(page).locator('aside').boundingBox();
  assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 320);
  await page.screenshot({ path: join(artifacts, 'notes-narrow.png') });
  await page.setViewportSize({ width: 1280, height: 800 }); await page.screenshot({ path: join(artifacts, 'notes-desktop.png') });
  assert.deepEqual(await page.locator('main').evaluate(el => [getComputedStyle(el).fontFamily, getComputedStyle(el).color, document.styleSheets.length]), nativeStyle);
  await host(page).locator('#prrc-heading').focus(); await page.keyboard.press('Escape');
  assert.equal(await host(page).evaluate(el => el.shadowRoot.activeElement?.textContent), 'Review Companion');
  assert.deepEqual(errors, []);
  console.log('PASS actual sender/storage boundaries, narrow viewport, unchanged GitHub CSS, keyboard close and no uncaught errors');
} finally { await context.close(); }
