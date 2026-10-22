// Run against dist/ with an existing Playwright installation. No real credentials.
import assert from "node:assert/strict";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE || "playwright"
);
const root = resolve(import.meta.dirname, "../..");
const artifacts = join(root, "test-results/step5");
await mkdir(artifacts, { recursive: true });
const context = await chromium.launchPersistentContext(
  await mkdtemp(join(tmpdir(), "prrc-jump-")),
  {
    executablePath: process.env.CHROME_EXECUTABLE || undefined,
    headless: true,
    viewport: { width: 1280, height: 800 },
    args: [
      `--disable-extensions-except=${root}/dist`,
      `--load-extension=${root}/dist`,
    ],
  },
);
const errors = [];
context.on("page", (page) =>
  page.on("pageerror", (error) => errors.push(error.message)),
);
let apiRequests = 0;
const base = "https://github.com/fixture/repository/pull/123";
const comment = (n, url = `${base}#discussion_r${n}`) => ({
  id: `C${n}`,
  url,
  state: "SUBMITTED",
  body: `Published comment ${n}`,
  author: null,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
});
const thread = (id, comments) => ({
  id,
  isResolved: false,
  isOutdated: true,
  path: "src/" + "long-path-".repeat(12) + "file.ts",
  line: null,
  originalLine: null,
  startLine: null,
  originalStartLine: null,
  diffSide: "RIGHT",
  startDiffSide: null,
  comments: {
    nodes: comments,
    pageInfo: { hasNextPage: false, endCursor: null },
  },
});
await context.route("https://api.github.com/**", (route) => {
  // Let the anonymous public page make its own requests. Synthetic credentials
  // are intercepted here and can never reach GitHub.
  if (
    route.request().headers().authorization !==
    "Bearer github_pat_fixture_jump_only"
  )
    return route.continue();
  apiRequests++;
  if (new URL(route.request().url()).pathname === "/user")
    return route.fulfill({ json: { id: 42, login: "fixture" } });
  const { owner, number } = route.request().postDataJSON().variables;
  const live = owner === "microsoft";
  return route.fulfill({
    json: {
      data: {
        repository: {
          pullRequest: {
            id: `PR${number}`,
            number,
            title: "Jump verification",
            state: "OPEN",
            isDraft: false,
            url: live ? "https://github.com/microsoft/vscode/pull/274" : base,
            reviewThreads: {
              nodes: live
                ? [
                    thread("live", [
                      comment(
                        45394374,
                        "https://github.com/microsoft/vscode/pull/274#discussion_r45394374",
                      ),
                    ]),
                  ]
                : [
                    thread("T1", [comment(11), comment(12)]),
                    thread("T2", [comment(31)]),
                    thread("T3", []),
                  ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      },
    },
  });
});
const html = `<!doctype html><html><head><title>GitHub jump fixture</title><style>
body{margin:0;font:16px Georgia;background:rgb(240,241,242)} header{position:fixed;top:0;height:70px;width:100%;background:white;z-index:20}
main{padding:90px 25px 1000px} .spacer{height:1200px} article{padding:20px;background:white;border:1px solid gray} .tall{min-height:1000px}
</style></head><body><header>Sticky GitHub header</header><main><h1>Native GitHub fixture</h1><div class="spacer"></div>
<details id="native-details"><summary>Native review discussion</summary><article id="discussion_r12" class="tall"><h2>Discussion</h2><p>Long comment content</p></article></details>
</main></body></html>`;
await context.route("https://github.com/fixture/**", (route) =>
  route.fulfill({ contentType: "text/html", body: html }),
);
try {
  const worker =
    context.serviceWorkers()[0] ||
    (await context.waitForEvent("serviceworker"));
  const id = new URL(worker.url()).host;
  const options = await context.newPage();
  await options.goto(`chrome-extension://${id}/src/options/options.html`);
  await options
    .getByLabel("Fine-grained personal access token")
    .fill("github_pat_fixture_jump_only");
  await options
    .getByRole("button", { name: "Verify and save", exact: true })
    .click();
  await options.getByText("Saved account: @fixture", { exact: true }).waitFor();
  const page = await context.newPage();
  await page.bringToFront();
  await page.goto(base);
  const host = page.locator("#pr-review-companion-host");
  const launcher = page.getByRole("button", {
    name: "Review Companion",
    exact: true,
  });
  const buttons = host.getByRole("button", {
    name: "Jump to discussion",
    exact: true,
  });
  const open = async () => {
    await launcher.click();
    await page
      .getByText("Complete result · fresh · cached locally", { exact: true })
      .waitFor();
  };
  const originalStyle = await page
    .locator("main")
    .evaluate((el) => ({
      font: getComputedStyle(el).fontFamily,
      sheets: document.styleSheets.length,
    }));
  await launcher.waitFor();
  assert.equal(apiRequests, 1);
  await open();
  assert.equal(await buttons.count(), 3);
  assert.equal(await buttons.nth(2).isDisabled(), true);
  assert.equal(await host.locator("summary button").count(), 0);
  const before = apiRequests;
  await buttons.first().focus();
  await page.keyboard.press("Enter");
  await host.locator("aside").waitFor({ state: "detached" });
  assert.equal(
    await page.evaluate(() => document.activeElement.id),
    "discussion_r12",
  );
  assert.equal(await page.locator("#native-details").getAttribute("open"), "");
  await host.locator(".jump-highlight").waitFor();
  await page.waitForFunction(() => {
    const rect = document
      .getElementById("discussion_r12")
      .getBoundingClientRect();
    return rect.top >= 81 && rect.top < innerHeight - 50;
  });
  await page.screenshot({ path: join(artifacts, "highlight-desktop.png") });
  await host.locator(".jump-highlight").waitFor({ state: "detached" });
  assert.equal(
    await page.locator("#discussion_r12").getAttribute("tabindex"),
    null,
  );
  assert.equal(page.url(), base);
  assert.equal(apiRequests, before);
  assert.deepEqual(
    await page
      .locator("main")
      .evaluate((el) => ({
        font: getComputedStyle(el).fontFamily,
        sheets: document.styleSheets.length,
      })),
    originalStyle,
  );
  console.log(
    "PASS keyboard jump, later published comment, native disclosure, outdated/null-line thread, tall target below sticky header, focus, highlight expiry, zero API traffic",
  );

  await open();
  await buttons.nth(1).click();
  await host
    .locator(".notice")
    .getByText("This discussion isn’t available on the current page.", {
      exact: true,
    })
    .waitFor();
  const fallback = host.locator(".notice a");
  assert.equal(await fallback.getAttribute("href"), `${base}#discussion_r31`);
  assert.equal(await fallback.getAttribute("target"), "_blank");
  assert.equal(await fallback.getAttribute("rel"), "noopener noreferrer");
  const popupWait = context.waitForEvent("page");
  await fallback.click();
  const fallbackPage = await popupWait;
  await fallbackPage.waitForURL(`${base}#discussion_r31`);
  await fallbackPage.close();
  await page.bringToFront();
  assert.equal(page.url(), base);
  assert.equal(apiRequests, before);
  // Content that appears after the bounded timeout must not trigger an old jump.
  await page.evaluate(() => {
    const el = document.createElement("article");
    el.id = "discussion_r31";
    el.textContent = "Delayed after timeout";
    document.querySelector("main").append(el);
  });
  await page.waitForTimeout(150);
  assert.equal(await host.locator("aside").count(), 1);
  assert.equal(await host.locator(".jump-highlight").count(), 0);
  await page.locator("#discussion_r31").evaluate((el) => el.remove());
  console.log(
    "PASS missing target fallback opens a new tab; late DOM after timeout does not jump",
  );

  // A delayed exact anchor within the bounded wait succeeds.
  await buttons.nth(1).click();
  await page.evaluate(() => {
    setTimeout(() => {
      const el = document.createElement("article");
      el.id = "discussion_r31";
      el.tabIndex = 0;
      el.textContent = "Delayed target";
      document.querySelector("main").append(el);
    }, 100);
  });
  await host.locator("aside").waitFor({ state: "detached" });
  assert.equal(
    await page.evaluate(() => document.activeElement.id),
    "discussion_r31",
  );
  await page.locator("#discussion_r31").evaluate((el) => el.remove());
  await host.locator(".jump-highlight").waitFor({ state: "detached" });

  // First published comment wins when both anchors are available; reduced motion is immediate.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.evaluate(() => {
    const el = document.createElement("article");
    el.id = "discussion_r11";
    el.tabIndex = 0;
    el.textContent = "First comment";
    document.querySelector("main").prepend(el);
  });
  await open();
  await buttons.first().click();
  await host.locator("aside").waitFor({ state: "detached" });
  assert.equal(
    await page.evaluate(() => document.activeElement.id),
    "discussion_r11",
  );
  assert.equal(
    await page.locator("#discussion_r11").getAttribute("tabindex"),
    "0",
  );
  await host.locator(".jump-highlight").waitFor();
  await page.setViewportSize({ width: 320, height: 650 });
  await page.screenshot({ path: join(artifacts, "highlight-narrow.png") });
  await host.locator(".jump-highlight").waitFor({ state: "detached" });
  assert.equal(
    await page.locator("#discussion_r11").getAttribute("tabindex"),
    "0",
  );
  console.log(
    "PASS delayed rendering, target removal cleanup, first-comment preference, existing tabindex preservation, reduced motion, narrow viewport",
  );

  // Same-PR navigation cancels lookup without discarding the drawer or refetching.
  await open();
  await buttons.nth(1).click();
  await page.evaluate(() =>
    history.pushState({}, "", "/fixture/repository/pull/123/files"),
  );
  await page.waitForTimeout(100);
  await page.evaluate(() => {
    const el = document.createElement("article");
    el.id = "discussion_r31";
    el.textContent = "New route target";
    document.querySelector("main").append(el);
  });
  await page.waitForTimeout(150);
  assert.equal(await host.locator("aside").count(), 1);
  assert.equal(await host.locator(".jump-highlight").count(), 0);
  assert.equal(apiRequests, before);
  await buttons.nth(1).click();
  await host.locator("aside").waitFor({ state: "detached" });
  assert.equal(
    await page.evaluate(() => document.activeElement.id),
    "discussion_r31",
  );
  await open();
  await page.locator("#discussion_r31").evaluate((el) => el.remove());
  await buttons.nth(1).click();
  await host.getByRole("button", { name: "Close", exact: true }).click();
  assert.equal(
    await host.evaluate((el) => el.shadowRoot.activeElement?.textContent),
    "Review Companion",
  );
  await page.waitForTimeout(2100);
  assert.equal(await host.locator(".jump-highlight").count(), 0);
  console.log(
    "PASS same-PR route cancellation, files-route jump, manual close focus restoration and cancellation",
  );

  // Hidden content must not create an observer feedback loop by repeatedly
  // opening/restoring its native details ancestor. Unknown anchors never match.
  await open();
  for (const subpage of ["commits", "checks"]) {
    await page.evaluate((subpage) => {
      history.pushState({}, "", `/fixture/repository/pull/123/${subpage}`);
      const wrapper = document.createElement("div");
      wrapper.id = "hidden-fixture";
      wrapper.style.display = "none";
      wrapper.innerHTML =
        '<details><summary>Hidden native review</summary><article id="discussion_r31">Hidden comment</article></details>';
      document.querySelector("main").append(wrapper);
    }, subpage);
    await page.waitForTimeout(100);
    await buttons.nth(1).click();
    await host
      .locator(".notice")
      .getByText("This discussion isn’t available on the current page.", {
        exact: true,
      })
      .waitFor();
    assert.equal(
      await page.locator("#hidden-fixture details").getAttribute("open"),
      null,
    );
    assert.equal(await host.locator("aside").count(), 1);
    await page.locator("#hidden-fixture").evaluate((el) => el.remove());
  }
  await buttons.nth(1).click();
  await buttons.first().click();
  await host.locator("aside").waitFor({ state: "detached" });
  assert.equal(
    await page.evaluate(() => document.activeElement.id),
    "discussion_r11",
  );
  assert.equal(apiRequests, before);
  await open();
  console.log(
    "PASS commits/checks hidden-target fallback, disclosure restoration, repeated clicks supersede pending lookup",
  );

  await buttons.nth(1).click();
  await host.getByRole("button", { name: "Refresh", exact: true }).click();
  await page
    .getByText("Complete result · fresh · cached locally", { exact: true })
    .waitFor();
  assert.equal(
    await host
      .getByText("Finding discussion on this page…", { exact: true })
      .count(),
    0,
  );
  await buttons.nth(1).click();
  await options
    .getByRole("button", { name: "Disconnect", exact: true })
    .click();
  await host.getByText(/Connect your GitHub account/).waitFor();
  assert.equal(await host.locator(".jump-highlight").count(), 0);
  assert.equal(await buttons.count(), 0);
  console.log("PASS refresh and cross-tab disconnect invalidate pending jumps");

  // Optional actual public GitHub DOM verification; review responses remain controlled.
  if (process.env.LIVE_GITHUB === "1") {
    await options
      .getByLabel("Fine-grained personal access token")
      .fill("github_pat_fixture_jump_only");
    await options
      .getByRole("button", { name: "Verify and save", exact: true })
      .click();
    await options
      .getByText("Saved account: @fixture", { exact: true })
      .waitFor();
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.bringToFront();
    await page.goto("https://github.com/microsoft/vscode/pull/274", {
      waitUntil: "domcontentloaded",
    });
    await launcher.waitFor();
    await open();
    const liveBefore = apiRequests;
    await buttons.first().click();
    await host.locator("aside").waitFor({ state: "detached" });
    assert.equal(
      await page.evaluate(() => document.activeElement.id),
      "discussion_r45394374",
    );
    await host.locator(".jump-highlight").waitFor();
    await page.screenshot({ path: join(artifacts, "live-public-github.png") });
    assert.equal(apiRequests, liveBefore);
    console.log(
      "PASS actual public GitHub conversation DOM anchor and focus (controlled review API; no live credential test)",
    );
  }
  assert.deepEqual(errors, []);
  console.log("PASS no uncaught page errors");
} finally {
  await context.close();
}
