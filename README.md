# PR Review Companion

A Chrome extension for keeping track of GitHub pull-request reviews.

**Status: step 2 — secure GitHub authentication.** Connect one fine-grained
personal access token, verify the account, optionally check a repository, replace
the credential, or disconnect. Review fetching, queues, notes, polling,
notifications, and the injected PR panel are not implemented yet.

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

**Disconnect** removes local authentication state. It does not revoke the token
on GitHub; revoke it in GitHub settings separately if desired. Other extension
storage, including future notes, is preserved.

Coverage is limited to the configured token's accessible repositories. One
fine-grained token cannot cover private repositories across multiple resource
owners. A successful public-repository check does not prove private-repository
permission, and an empty repository can pass. A 404 means not found or
inaccessible; the extension cannot distinguish those cases reliably.

## Credential and network boundaries

- The worker restricts `chrome.storage.local` to trusted extension contexts before
  reading or writing authentication state. Content scripts cannot read it.
- Only the options page can submit, replace, recheck, disconnect, or check access.
  The popup can read sanitized status. Content-script and unknown callers are
  rejected. Runtime message payloads and GitHub responses are validated with Zod.
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

Vitest covers sender validation, storage initialization, safe failures, persistence,
failed replacement, disconnect/replacement races, response validation, access
errors, timeouts, and rate-limit cooldown across worker restart. Fixtures use
synthetic credentials only.

The production build was exercised in an isolated Chrome for Testing profile with
synthetic credentials and intercepted GitHub responses: setup, failed/successful
replacement, repository checks, worker restart, recheck/recovery, and disconnect
passed. Actual content-script storage reads and authentication messages were denied;
opening the popup made no API request. Real GitHub credential validation remains a
manual check, not a claim made by these mocked browser tests.

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

Do not put real tokens in chat, source files, test fixtures, logs, or screenshots.

## Structure and next steps

- `manifest.config.ts` and `vite.config.ts`: extension entrypoints and build setup.
- `src/background/auth`: worker-only credential lifecycle and GitHub access checks.
- `src/background` and `src/content`: message entrypoint and inert GitHub bootstrap.
- `src/popup`, `src/options`, `src/shared`, `src/styles`: React extension surfaces.
- [Architecture](PR_REVIEW_COMPANION_ARCHITECTURE.md): full design and later stages.

The next step builds the GitHub review-data layer: response schemas, pagination,
caching, and rate-limit handling for review reads. Changes remain local until you
commit and push them; Chrome Web Store publication and CI remain later work.
