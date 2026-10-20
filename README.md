# PR Review Companion

A Chrome extension for keeping track of GitHub pull-request reviews.

**Status: step 1 — local scaffold.** The popup and settings page work, and an inert
bootstrap runs on GitHub. Authentication, review queues, notes, polling,
notifications, and the injected PR panel are not implemented yet. There is no
token input or GitHub API traffic.

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

## Checks

Scaffold verification: dependency installation, strict type checking, production
bundling, manifest asset references, icon sizes, and absence of development-server
references in the production output passed. Browser loading, button behavior,
live bootstrap diagnostics, and hot refresh remain unverified: this session's
Chrome test launch and local-server permission requests were declined.

```sh
npm run typecheck
npm run build
```

The production build runs type checking before bundling. For a browser smoke check:

- Inspect the service worker from the extension card; confirm it has no errors.
- Open the popup and use **Open settings** with keyboard or mouse.
- Confirm the options page has no credential inputs and says **Not connected**.
- In development, directly load both a GitHub repository homepage and an existing
  PR. Confirm the bootstrap diagnostics classify each correctly.
- Confirm GitHub's page appearance is unchanged and the extension makes no requests
  to `api.github.com`.
- Edit popup text temporarily, verify it updates without rebuilding, then restore it.
- Stop the development server and confirm the production copy still opens correctly.

## Permissions and boundaries

The manifest declares the architecture's future `storage`, `alarms`, and
`https://api.github.com/*` permissions. Step 1 does not use them. Notifications are
optional and are never requested by this scaffold. A GitHub-wide isolated-world
content script leaves room for detecting navigation into PRs in a later step;
there is no separate broad GitHub host permission or access to other sites.

All production scripts, styles, and icons are bundled locally. Tailwind styles are
imported only by the extension popup and options page, never by the GitHub bootstrap.
The four PNG icons in `public/icons` are temporary development branding.

## Structure and next steps

- `manifest.config.ts` and `vite.config.ts`: extension entrypoints and build setup.
- `src/background` and `src/content`: worker and inert GitHub bootstrap.
- `src/popup`, `src/options`, `src/shared`, `src/styles`: React extension surfaces.
- [Architecture](PR_REVIEW_COMPANION_ARCHITECTURE.md): full design and later stages.

The next step adds secure single-token setup, trusted-context storage access, and
validated worker messaging. This scaffold does not commit, push, publish to the
Chrome Web Store, or include CI and feature-specific test suites.
