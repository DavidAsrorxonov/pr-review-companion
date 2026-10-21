# PR Review Companion

A Chrome extension for keeping track of GitHub pull-request reviews.

**Status: step 3 — review data and settings preview.** Connect one fine-grained
personal access token and load a selected pull request in settings to inspect its
paginated review-thread and published-comment counts. Queues, notes, polling,
notifications, thread jumping, and the injected PR panel remain later steps.

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

The content bootstrap deliberately imports no CSS, adds no elements, and handles
only the initial document URL. GitHub SPA navigation and the panel are a later
step. In development, open a GitHub page's DevTools Console and enable **Verbose**
logs to see `[PR Review Companion] Bootstrap: PR` or `non-PR`. A directly opened
`/owner/repo/pull/123` route is a PR; repository homepages, `/pulls`, and `/pull/new`
are not. Diagnostics are removed from production output.

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
incomplete. Snapshot data includes comment bodies for the later panel; disconnect
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
  The popup can read sanitized status. Content-script and unknown callers are
  rejected. Review operations are options-only and continuation IDs are bound to
  Chrome's sender document ID. Runtime messages and GitHub responses are validated
  with Zod; callers cannot supply tokens, query documents, or request cursors for
  review reads.
- Only the worker constructs authenticated requests to `https://api.github.com`.
  Browser cookies and redirects are disabled, requests time out after 15 seconds,
  and errors never include tokens, headers, or raw response bodies.
- Rate-limit retry times are persisted across worker restarts. Retries are manual;
  there is no background polling. Repository checks discard returned PR data.
- Credentials remain in this Chrome profile, not `storage.sync`. Trusted extension
  pages technically retain local-storage access; this is an access restriction,
  not encryption at rest or protection against a compromised trusted page.
- The manifest retains `alarms` for a future step and optional `notifications`.
  Authentication does not create alarms, request notifications, or change GitHub
  pages. The isolated GitHub bootstrap still imports no CSS.

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
Fixtures use synthetic credentials only.

The production build was exercised in an isolated Chrome for Testing profile with
synthetic credentials and intercepted GitHub responses: setup, failed/successful
replacement, repository checks, worker restart, recheck/recovery, and disconnect
passed. Actual content-script storage reads and authentication messages were denied;
opening the popup made no API request. Step 3 production browser checks also
passed nested pagination/progress, complete counts, cached reads, stale fallback,
cancellation, worker interruption/cache recovery, cross-tab replacement/disconnect,
escaped titles, and unchanged GitHub DOM/styles. No uncaught page errors occurred.
Real GitHub credential and GraphQL permission checks remain manual, not claims
made by these mocked browser tests.

Step 1 was successfully loaded and run in Chrome by the project owner. For the
step 2 live-account smoke check, enter a real token only in the extension UI:

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

Do not put real tokens in chat, source files, test fixtures, logs, or screenshots.

## Structure and next steps

- `manifest.config.ts` and `vite.config.ts`: extension entrypoints and build setup.
- `src/background/auth`: worker-only credential lifecycle and GitHub access checks.
- `src/background/reviews`: fixed GraphQL reads, pagination jobs, cache, and errors.
- `src/background` and `src/content`: message entrypoint and inert GitHub bootstrap.
- `src/popup`, `src/options`, `src/shared`, `src/styles`: React extension surfaces.
- [Architecture](PR_REVIEW_COMPANION_ARCHITECTURE.md): full design and later stages.

The next step adds the PR panel: Shadow DOM mounting, GitHub navigation handling,
route cleanup, safe content-script read authorization, and unresolved-thread UI. Changes remain local until you
commit and push them; Chrome Web Store publication and CI remain later work.
