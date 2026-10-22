# PR Review Companion

A Chrome extension for keeping track of GitHub pull-request reviews.

**Status: step 5 — Jump to review discussions.** Open the Review Companion drawer
on a GitHub pull request to inspect unresolved discussions grouped by file and
jump to a published comment on the page. The settings PR URL preview remains
available. Notes, queues, polling, notifications, and GitHub write operations remain later steps.

## Requirements and installation

- Node.js 22.12 or newer (tested locally with Node 22.15.1)
- npm and a current Chrome release

```sh
npm ci
npm run build
```

Dependencies are pinned in `package-lock.json`. The project is private in npm
metadata to prevent accidental package publication; its GitHub repository is public.

## Load the production extension

1. Build with `npm run build`.
2. Open `chrome://extensions` in a separate Chrome profile for development.
3. Enable **Developer mode**, choose **Load unpacked**, and select this project's
   `dist` directory (not the project root).
4. Pin **PR Review Companion** from Chrome's extensions menu and open its popup.
5. Select **Open settings** to open the options page in a tab.

The production build runs without a development server. After rebuilding, click
**Reload** on the extension's card, reopen the popup, and refresh any GitHub tabs
to load updated content scripts. An idle service worker is normal: Chrome wakes
it for registered events.

## Development

```sh
npm run dev
```

Keep the server running at `http://127.0.0.1:5173`. Load **`dist-dev`** through
**Load unpacked** for development; `dist` remains the independent production build.
Disable the other build while testing so two copies are not enabled together.

React UI changes refresh through CRXJS/Vite hot module replacement. Manifest
changes require reloading the extension; reload after worker changes when testing
lifecycle events, and refresh GitHub tabs to rerun their bootstrap. If startup
reports port 5173 is occupied, stop the process using it before restarting.

The lightweight content bootstrap runs on GitHub pages to detect navigation into
and out of PRs. React, validation, and panel styles are loaded only on supported
PR routes. Panel CSS is a bundled string installed exclusively inside its Shadow
DOM; no stylesheet is added to GitHub's document. Reload GitHub tabs after an
extension reload so their content scripts use the latest build.

## Use the GitHub panel

1. Connect GitHub in settings, then open a PR conversation, files, commits, or
   checks page. Click **Review Companion** at the bottom-right.
2. The drawer checks your saved connection, then loads cached or current reviews.
   Merely visiting a PR with the drawer closed makes no GitHub API requests.
3. Unresolved threads are grouped by file. Expand a thread to read its published
   comments as plain text and use **Open comment on GitHub** for a permalink.
   Resolved threads contribute to the summary but are not listed. Outdated threads
   can be unresolved or resolved. **Jump to discussion** finds an available published
   comment, collapses the drawer, scrolls to it, and moves keyboard focus there.
4. **Refresh** bypasses cache freshness; **Cancel loading** stops pagination.
   **Load reviews** explicitly retries an interrupted or failed load. Retry deadlines
   remain enforced. **Open settings** handles missing/invalid credentials.
5. **Close**, the launcher, or Escape while focus is in the drawer collapses it.
   Closing stops pagination and restores launcher focus. Reopening uses the normal
   cache-or-fetch path. The drawer is nonmodal; GitHub remains interactive.

Same-PR subpages and fragments preserve the panel and do not refetch. A different
PR resets it to closed and drops old data; non-PR pages have no launcher. Back/forward,
page restoration, and GitHub DOM replacement are handled without duplicate hosts.
When the page is hidden, active loading stops; returning verifies saved status
before showing retained data, without fetching GitHub automatically. Credential
replacement/disconnect clears visible data in other tabs; load again explicitly.

### Jump to a discussion

Jumping uses exact `discussion_r…` anchors from the loaded comment permalinks,
preferring the first published comment when present. It never guesses from file
paths, line numbers, or GraphQL node IDs. Outdated and file-level discussions work
when their comment is rendered. Closed native disclosure ancestors can be opened;
the extension does not click GitHub's load-more controls or fetch missing content.

The discussion receives a 2.5-second outline inside the extension's Shadow DOM.
Scrolling respects reduced motion, and temporary focus attributes are restored.
Successful jumping stops pagination; ordinary Close/Escape still returns focus to
the launcher. Jumping itself makes no API requests and never changes the URL.

If no target appears within two seconds, the drawer stays open and offers **Open
comment on GitHub** in a new tab. Commits/checks pages and GitHub layouts without
the supported anchor often need this fallback. No valid published permalink means
the jump button is disabled. Hidden, inaccessible, or unloaded discussions are not
treated as deleted. New jumps, navigation, refresh, closing, page suspension, and
credential changes cancel pending lookup work; highlights disappear on removal or
invalidation. No new permissions, worker messages, or persisted settings are added.

The manifest now includes `https://github.com/*` host access so the worker can
verify the current tab's PR URL before serving content-script reads. This is in
addition to GitHub API access. No broad `tabs`, `webNavigation`, or `scripting`
permission is requested. After rebuilding, reload the extension, accept updated
GitHub site access if Chrome prompts, and refresh GitHub tabs.

## Connect GitHub

1. Open the extension's settings and follow **Create a fine-grained token on GitHub**.
2. Select a resource owner and the repositories you want to review. Grant
   **Pull requests: Read-only**; metadata read access is included automatically.
   Set an expiration date. Organization policies may require approval.
3. Paste the token into the password field and choose **Verify and save**.
4. Optionally enter `owner/repo` under **Check repository access** and choose
   **Check access**. Identity verification alone does not verify repository grants.

The saved account and last successful verification time appear in settings. The
popup reads saved status without a GitHub request. Use **Recheck connection** to
verify the saved credential again; a network failure preserves the last verified
identity and marks current validity unknown. **Replace token** verifies the new
credential before saving; a failed replacement preserves the old connection.
The input clears after each completed submission and never reveals a saved token.

**Disconnect** removes the local credential and review cache, and cancels active
review loads. It does not revoke the token on GitHub; revoke it in GitHub settings
separately if desired. Unrelated storage, including future notes, is preserved.
A shared secondary-rate-limit deadline is retained until it expires.

Coverage is limited to the configured token's accessible repositories. One
fine-grained token cannot cover private repositories across multiple resource
owners. A successful public-repository check does not prove private-repository
permission, and an empty repository can pass. A 404 means not found or
inaccessible; the extension cannot distinguish those cases reliably.

## Preview a pull request

1. In settings, connect GitHub, then find **Review data preview**.
2. Paste `https://github.com/owner/repo/pull/123` (the files, commits, and checks
   subpages are accepted too), then choose **Load PR**.
3. Watch the page/thread/comment progress. Counts stay provisional until every
   thread page and nested comment page has finished.
4. Use **Refresh** to bypass freshness or **Cancel** to stop an active load.

The preview shows title, state, total/resolved/unresolved/outdated threads, and
published review-comment counts. Outdated counts overlap resolution counts.
General PR conversation comments, pending draft comments, and review-summary
bodies are not counted. Pagination completeness is not an atomic snapshot when
people change discussions during the fetch. GitHub content is escaped text;
comment HTML and remote assets are never rendered.

Complete snapshots are stored in trusted local storage, scoped to the account
and credential revision. Freshness lasts **60 seconds**; the cache keeps at most
**20 PRs / 4 MiB**, evicting least recently used entries. Snapshots larger than the
cache budget are shown as uncached. A load exceeding **8 MiB** stops explicitly
incomplete. Snapshot data includes comment bodies for the panel; disconnect
or successful token replacement clears it. Failed replacement preserves it.

Each load/continuation performs at most one GitHub request. Jobs belong to the
options document, expire after five idle minutes, and exist only in worker memory.
Closing settings stops requesting more pages; a worker restart interrupts unfinished
jobs. Load again to restart pagination. Completed cache entries survive restart.
There are at most two concurrent GraphQL requests and no automatic error retries,
alarms, polling, or review fetching when settings/popup merely opens or gains focus.

A failed refresh keeps the last complete snapshot visibly stale alongside the
error. Partial progress never replaces that snapshot. Definite access denial or
not-found suppresses the affected cached PR; invalid credentials suppress all
review data. A 404 does not prove deletion. REST repository-check success does
not guarantee GraphQL access. Rate-limit deadlines survive worker restarts:
REST and GraphQL primary limits are separate, while explicit secondary limits
block both APIs. After the indicated time, retry manually.

## Credential and network boundaries

- The worker restricts `chrome.storage.local` to trusted extension contexts before
  reading or writing authentication state. Content scripts cannot read it.
- Only the options page can submit, replace, recheck, disconnect, or check access.
  The popup can read sanitized authentication status. Content scripts cannot use
  any `auth.*` operation or read storage. The top-frame GitHub content script can
  read only the current PR, obtain minimal panel connection status, and open the
  fixed settings page. The worker checks the tab's current URL, and binds jobs to
  tab/document/PR/credential revision. Options keeps its existing review access.
  Runtime messages and GitHub responses are validated with Zod; callers cannot
  supply tokens, query documents, or request cursors for review reads.
- Only the worker constructs authenticated requests to `https://api.github.com`.
  Browser cookies and redirects are disabled, requests time out after 15 seconds,
  and errors never include tokens, headers, or raw response bodies.
- Rate-limit retry times are persisted across worker restarts. Retries are manual;
  there is no background polling. Repository checks discard returned PR data.
- Credentials remain in this Chrome profile, not `storage.sync`. Trusted extension
  pages technically retain local-storage access; this is an access restriction,
  not encryption at rest or protection against a compromised trusted page.
- The manifest retains `alarms` for a future step and optional `notifications`.
  No alarms or notifications are created. The isolated content script adds only
  its own panel host; GitHub layout, global styles, and page scripts are unchanged.
  Shadow DOM provides style isolation, not a credential security boundary.

## Checks

```sh
npm test
npm run typecheck
npm run build
```

Vitest covers authentication plus review sender validation, independent thread
and comment pagination beyond 100 items, duplicates/nulls, partial GraphQL errors,
cursor loops, cache freshness/eviction/size limits, storage failures, cancellations,
credential races, interrupted jobs, and shared/separate rate-limit cooldowns.
Step 4 adds route-bound content authorization, navigation lifecycle, stale PR and
credential replies, focus revalidation, cancellation, and unresolved grouping.
Step 5 adds permalink validation, bounded lookup, obsolete callback rejection,
highlight cleanup, and same-PR jump cancellation. All 198 Vitest tests, strict
TypeScript checking, and the production build pass.
Fixtures use synthetic credentials only.

The production build was exercised in an isolated Chrome for Testing profile with
synthetic credentials and intercepted GitHub responses: setup, failed/successful
replacement, repository checks, worker restart, recheck/recovery, and disconnect
passed. Actual content-script storage reads and authentication messages were denied;
opening the popup made no API request. Step 3 production browser checks also
passed nested pagination/progress, complete counts, cached reads, stale fallback,
cancellation, worker interruption/cache recovery, cross-tab replacement/disconnect,
escaped titles, and unchanged GitHub DOM/styles. No uncaught page errors occurred.
Step 4 production checks passed repository-to-PR and direct entry, same-PR subpages,
PR-to-PR/back/forward navigation, leaving PRs, host/body replacement, keyboard close
and focus restoration, a 320px viewport, plain-text lazy comments, stale fallback,
credential changes after worker restart, complete empty results, and access denials.
GitHub document styles stayed unchanged; collapsed panels made no API requests.
These are controlled-response browser checks, not a claim about live GitHub coverage.

Step 5 production browser checks passed keyboard jumping, first/available-comment
selection, native disclosure expansion, delayed targets, two-second fallback,
new-tab links, focus restoration, reduced motion, narrow layout, sticky headers,
highlight expiry/removal, same-PR navigation, refresh, and cross-tab disconnect.
Jumping added no API requests or document styles. Step 4's browser regression also
passed after these changes. Separately, the real public `microsoft/vscode#274`
conversation page was loaded and its actual `discussion_r45394374` comment was
focused/highlighted successfully, using controlled review data. No real-token
Step 5 smoke test has been performed by the implementation agent.

The project owner successfully ran Step 1 and confirmed Step 3 with a real PR URL:
the settings preview returned its title link and review threads. The owner also
confirmed that Step 4 worked live and pushed it to `main`. For the step 2
live-account smoke check, enter a real token only in the extension UI:

1. Verify and save it, close/reopen settings and popup, and confirm the account.
2. Stop the worker from Chrome's developer tools, reopen the popup, and confirm
   saved identity survives without an automatic API call.
3. Check a permitted repository, an empty repository, and an inaccessible one.
4. Try an invalid replacement; confirm the saved account survives and the password
   input clears. Then replace with a valid credential and recheck it.
5. Test offline rechecking: identity should remain with validity unknown.
6. Disconnect and confirm the popup becomes disconnected after reopening/focus.

For the step 3 live-account smoke check:

1. Enter a real token only in the extension UI and load an accessible PR URL.
2. Compare its review-thread counts with GitHub, including resolved/outdated
   discussions. If available, try a PR with more than 100 threads or a long thread.
3. Load again within 60 seconds to reuse cache; **Refresh** should fetch again.
4. Go offline and refresh: expect a stale last-complete result and an error.
5. Interrupt a long load by stopping the worker, then load again to restart.
6. Replace credentials or disconnect in a second settings tab; the first tab must
   clear its preview. Check an inaccessible PR and confirm it shows no cached data.

For the Step 4 live-GitHub smoke check after rebuilding/reloading:

1. Visit a repository homepage, then open a PR without a full reload. Confirm the
   closed launcher appears, then open it and compare discussions with GitHub.
2. Switch to Files changed and back, navigate to another PR, and use browser
   back/forward. Same-PR data should survive; different PRs should start closed.
3. Expand a thread, follow its comment permalink, and test Close/Escape and keyboard
   focus. Check the drawer at a narrow window width and GitHub's light/dark themes.
4. Refresh offline to check stale feedback. Cancel a load, then retry explicitly.
5. Replace credentials or disconnect in settings while a PR panel exists. Its
   previous data must disappear; opening settings from the panel must work.
6. Leave the PR and confirm the launcher is removed and GitHub remains usable.

Do not put real tokens in chat, source files, test fixtures, logs, or screenshots.

For the Step 5 live-account smoke check after rebuilding/reloading:

1. Open an accessible PR, load its reviews, and use **Jump to discussion** with
   mouse and keyboard. Confirm the drawer collapses and focus reaches the comment.
2. Try conversation and Files changed pages, an outdated thread, and a discussion
   inside a collapsed native disclosure. Check the temporary outline and scrolling.
3. Try an unavailable discussion on a commits/checks page. Expect a new-tab
   permalink offer after two seconds, with the current tab and drawer preserved.
4. Change PR/subpage, close the drawer, refresh, or disconnect while finding a
   target. No delayed jump should occur. Reopen the drawer and confirm normal loading.
5. Check a narrow window and reduced-motion mode. Confirm GitHub styling is
   unchanged and jumping itself creates no GitHub API traffic.

The repeatable controlled browser check is `tests/browser/step5.mjs`. It requires
an existing Playwright installation and Chromium supporting unpacked extensions:

```sh
npm run build
PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs \
CHROME_EXECUTABLE=/absolute/path/to/chrome \
node tests/browser/step5.mjs
```

It uses a separate temporary profile, synthetic credentials, and intercepted
extension API responses. Screenshots go to ignored `test-results/step5/`. Set
`LIVE_GITHUB=1` to also check the real public `microsoft/vscode#274` conversation
DOM using controlled review data. That optional check is not live authentication
or API verification; real-account smoke checks remain separate.

## Structure and next steps

- `manifest.config.ts` and `vite.config.ts`: extension entrypoints and build setup.
- `src/background/auth`: worker-only credential lifecycle and GitHub access checks.
- `src/background/reviews`: fixed GraphQL reads, pagination jobs, cache, and errors.
- `src/background/panel`: content sender/current-tab authorization and panel operations.
- `src/content`: lightweight navigation, lazy Shadow DOM mounting, and message transport.
- `src/panel`: drawer UI, thread grouping, and request lifecycle.
- `src/popup`, `src/options`, `src/shared`, `src/styles`: React extension surfaces.
- [Architecture](PR_REVIEW_COMPANION_ARCHITECTURE.md): full design and later stages.

The next step adds local notes. Changes remain local until you
commit and push them; Chrome Web Store publication and CI remain later work.
