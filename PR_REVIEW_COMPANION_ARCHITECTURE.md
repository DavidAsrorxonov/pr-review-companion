# PR Review Companion — Architecture

A Chrome extension (Manifest V3) that makes GitHub pull-request review less
painful: it tracks unresolved threads across review rounds, adds lightweight
review notes GitHub lacks, and shows a "waiting on you" queue with a toolbar
badge.

## 1. Goals & Non-Goals

**Goals**
- Show every unresolved review thread on a PR in one panel, with jump-to-line.
- Let reviewers keep general (non-line) review notes with a done/not-done state.
- Surface a cross-repo queue within the configured token's accessible repositories:
  PRs awaiting my review and PRs of mine with outstanding requests to others.
- Notify about new review requests and replies in monitored review threads.
- Keep the permission footprint limited to GitHub only.
- Survive GitHub UI changes without breaking core features.

**Non-Goals (v1)**
- No code review automation or AI suggestions.
- No GitHub Enterprise Server support (github.com only).
- No team-wide shared state or backend service — everything is local to the user.
- No Firefox support.
- No multi-token or unrestricted cross-organization private-repository coverage in v1.
- No alerts for general PR comments or newly created review threads in v1.

## 2. Surfaces

| Surface | Purpose | Runs where |
|---|---|---|
| Content script | Lightweight navigation bootstrap; panel and helpers activate only on PR routes | Bootstrap: `github.com/*`; panel: `github.com/*/*/pull/*` |
| Background service worker | Polls GitHub API, updates badge, fires notifications | Extension context |
| Popup | Review queue ("waiting on you" / "waiting on others") | Toolbar |
| Options page | Token setup, polling interval, notification settings | Extension tab |

## 3. Tech Stack

- **Build:** Vite + `@crxjs/vite-plugin` (no WXT)
- **UI:** React + TypeScript
- **Styling:** Tailwind inside a Shadow DOM root, with explicit inherited typography and theme defaults
- **Validation:** Zod for GitHub API responses and runtime message payloads
- **Data fetching:** GitHub GraphQL API (primary), REST only where GraphQL lacks coverage
- **State:** React state + `chrome.storage.local`; TanStack Query optional for popup caching
- **Testing:** Vitest for lib code, Playwright for content-script smoke tests

## 4. Folder Structure

```
pr-review-companion/
├── manifest.config.ts
├── vite.config.ts
├── package.json
├── tsconfig.json
│
├── src/
│   ├── content/
│   │   ├── index.ts               # GitHub-wide bootstrap; activate only on PR routes
│   │   ├── navigation.ts          # SPA navigation handling (GitHub swaps pages without reload)
│   │   ├── mountPanel.ts          # creates Shadow DOM host + React root
│   │   ├── domAnchors.ts          # ALL GitHub selectors live here, nowhere else
│   │   └── threadJump.ts          # scroll/highlight a thread by ID
│   │
│   ├── panel/                     # React UI injected by content script
│   │   ├── Panel.tsx
│   │   ├── components/
│   │   │   ├── ThreadList.tsx      # unresolved threads, grouped by file
│   │   │   ├── ThreadItem.tsx
│   │   │   ├── NotesList.tsx       # general review notes
│   │   │   ├── NoteEditor.tsx
│   │   │   └── ReviewSummary.tsx   # counts: unresolved / resolved / notes open
│   │   └── hooks/
│   │       ├── usePrContext.ts     # owner/repo/number from URL
│   │       ├── useReviewThreads.ts
│   │       └── useNotes.ts
│   │
│   ├── background/
│   │   ├── service-worker.ts       # alarm + message wiring
│   │   ├── poller.ts               # scheduled queue refresh
│   │   ├── badge.ts                # toolbar badge count
│   │   └── notifications.ts        # new review request / new reply alerts
│   │
│   ├── popup/
│   │   ├── popup.html
│   │   ├── Popup.tsx
│   │   └── components/
│   │       ├── QueueSection.tsx    # "Needs my review" / "My PRs waiting"
│   │       └── PrRow.tsx
│   │
│   ├── options/
│   │   ├── options.html
│   │   └── Options.tsx             # token entry, polling interval, toggles
│   │
│   ├── shared/
│   │   ├── github/
│   │   │   ├── client.ts           # authenticated GraphQL/REST wrapper
│   │   │   ├── queries/            # GraphQL query documents (threads, queue)
│   │   │   ├── schemas.ts          # Zod schemas for responses
│   │   │   └── rateLimit.ts        # reads rate-limit headers, backs off
│   │   ├── storage/
│   │   │   ├── tokenStore.ts       # worker-owned credential operations; trusted storage
│   │   │   ├── notesStore.ts       # account-scoped PR notes; accessed through worker
│   │   │   ├── notificationStore.ts # monitored PRs, checkpoints, delivery ledger
│   │   │   └── settingsStore.ts
│   │   ├── messaging.ts            # typed, runtime-validated messages and sender checks
│   │   └── types.ts
│   │
│   └── styles/
│       └── panel.css               # Tailwind entry, injected into Shadow DOM
│
├── public/icons/
└── store-assets/
```

## 5. Data Flow

### Navigation and PR loading
1. A small `index.ts` bootstrap runs on every `https://github.com/*` document.
   This installs navigation detection even when the initial page is a repository
   homepage or PR list. A PR-only injection match would miss entry into a PR
   through navigation that does not reload the document.
2. `navigation.ts` rechecks the URL on GitHub navigation events, browser history
   navigation, and DOM replacement. It activates only for supported PR routes,
   extracts owner/repo/number, and mounts or updates one panel. Outside PR routes,
   it removes the panel and stops PR-specific work while retaining the bootstrap.
3. `mountPanel.ts` creates a Shadow DOM host and React root idempotently, including
   when GitHub replaces the host's parent. Navigation tears down old subscriptions;
   responses carry PR identity and a request generation so stale results cannot
   populate a different PR's panel.
4. `useReviewThreads` requests data from the worker through the message boundary
   below. Content scripts never receive credentials or read storage directly.
5. The worker fetches and validates all review-thread pages, normalizes results,
   and returns data with completeness, freshness, and error status. Partial
   results remain visibly incomplete; summary counts are final only when complete.
6. `ThreadItem` uses `threadJump.ts` and `domAnchors.ts` to scroll/highlight when
   the target exists. Preserve a GitHub comment permalink as the fallback when
   the thread is not loaded or a selector fails.

### Worker messages and storage boundary
- Initialize `chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" })`
  before persisting credentials or serving storage-dependent requests. Fail closed
  if initialization fails. This restricts the entire local storage area, so notes,
  settings, and cached data also pass through the worker for content scripts.
- Allow only named operations: credential setup/removal, authentication status,
  PR-thread reads, note CRUD, queue reads/refreshes, and settings reads/updates.
  Validate payloads at runtime with Zod and verify the extension sender ID and
  sender URL. Credential setup/removal is accepted only from the options page;
  settings writes and queue controls are restricted to their extension UI callers.
  Content scripts receive only PR data, notes, and needed display preferences.
- Keep GitHub request construction inside the worker: messages cannot supply
  arbitrary fetch URLs, authorization headers, or GraphQL documents. For content
  requests, validate the GitHub PR route and its relation to the requested PR.
- Return normalized results, never credentials, headers, or raw sensitive errors.
  Represent `complete`, `fetchedAt`, and loading/stale/error status explicitly.
  Only the options page handles token input; it clears the input after setup.

### Queue semantics
Both queues contain accessible, open, non-draft PRs and deduplicate by PR node ID.

| Queue | Inclusion rule |
|---|---|
| Needs my review | An outstanding direct or team review request involves the authenticated user |
| My PRs waiting | The authenticated user authored the PR and it has an outstanding request to another user or team |

Use review-request search semantics for discovery, then retrieve review requests,
draft/state, and review decisions for classification. Inspect authored open PRs
for outstanding requests rather than filtering them by unresolved threads.
Requested changes and unresolved discussions are separate indicators: neither
alone means the author is waiting on reviewers. A PR can have requested changes
and still await another requested reviewer; show both facts. An authored PR
awaiting its first requested review qualifies even if it has no threads.
The badge counts distinct PRs in **Needs my review** only. Show pending team
requests as team requests rather than implying an individual assignment.

### Background refresh and pagination
1. A `chrome.alarms` alarm triggers a serialized refresh. Recheck/recreate the
   configured alarm at worker initialization and load persisted state on wake.
2. Discover requested-review and authored open PRs, classify the queues, and
   refresh monitored review threads independently of queue membership.
3. Traverse GraphQL connections using `pageInfo.hasNextPage` and `endCursor`.
   Paginate threads, queue results, review requests, and comments needed for
   classification or notifications; nested comment connections need their own
   cursors. A page contains at most 100 items. Partition searches that hit search
   result limits, or explicitly report incomplete coverage instead of truncating.
4. Validate both transport failures and GraphQL errors/partial data. Back off on
   rate limits and persist the retry time. Interrupted pagination remains
   incomplete; continue or retry without treating absent results as removals.
5. Persist a successful queue snapshot with its timestamp, then update the badge.
   Keep the last successful snapshot on failure and show its stale/error status.
   Do not emit queue-change notifications from incomplete snapshots. Serialize
   notification-state updates with polling to avoid overlapping refresh races.

### Review-request and reply notifications
- Monitor accessible open PRs authored by the authenticated user and PRs discovered
  through their review requests. Persist monitored PR IDs even after review
  submission removes a request from the queue. Stop monitoring on closure/merge;
  suspend inaccessible PRs without assuming that they have closed.
- At first setup, token replacement, or notification enablement, establish silent
  queue and reply baselines from complete snapshots. First discovery of a monitored
  PR establishes its reply baseline only; a new review request can still alert
  according to the rule below. Do not notify about historical comments. Re-enabling
  access establishes a fresh baseline rather than replaying an unknown backlog.
- For review requests, notify when a PR enters Needs my review after the initial
  complete queue baseline. Persist membership transitions so a later re-request
  can notify again, while changes between team/direct requests on a PR already
  in the queue do not generate duplicate PR alerts.
- For replies, compare stable published comment IDs within previously observed
  review threads. Fetch all relevant comment pages, exclude the thread's initial
  comment and the authenticated user's own comments, and alert on new replies
  from other users. Edits to an existing comment are not new replies. Newly
  discovered threads are baselined silently; general PR comments are excluded.
- Persist account-scoped monitored PR IDs, known thread/comment IDs, successful
  checkpoints, and a delivery ledger. For each successful refresh, write the
  checkpoint and pending notification events together before attempting delivery.
  Use deterministic notification IDs derived from reply IDs or persisted request
  transition IDs, so retries target the same notification rather than a new one.
  Mark delivered events and do not replay them on worker restart. Chrome display
  and storage are not transactional: deterministic IDs limit duplicate delivery,
  but exactly-once user-visible alerts are not guaranteed after a crash.
- Do not advance a PR's reply checkpoint after incomplete pagination or a failed
  fetch. Bound retained history by monitored open PRs; retain pending deliveries
  until handled and prune state when monitoring ends. Store IDs rather than full
  comment bodies where possible to conserve local storage.

### Notes
- The worker persists notes via `notesStore.ts`, namespaced by authenticated
  account ID and PR identity (`owner/repo#number` in v1).
- Notes never leave the machine in v1. A token change does not delete notes;
  notes for another account remain isolated from the active account's UI.

## 6. Authentication

| Option | Pros | Cons |
|---|---|---|
| Fine-grained personal access token | No backend, scoped to chosen repos | Manual setup; private-repository coverage limited to one resource owner per token |
| OAuth device flow | No pasted token | Registered OAuth app and a separate permissions/security design |

**v1 decision:** one fine-grained personal access token, entered in the options
page, with repository permissions **Pull requests: read** and **Metadata: read**.
Revisit alternative authentication and multiple credentials after launch.

### Coverage and onboarding
- The queue covers repositories accessible with this token, not all repositories
  visible in the user's GitHub browser session. One fine-grained token cannot
  provide private-repository coverage across multiple organizations.
- Explain resource-owner selection, selected repository access, organization
  approval requirements, and token expiry in setup. Verify identity and API
  access, and show the authenticated account and configured coverage limitation
  in options and the queue. Do not claim to enumerate the token's exact grants
  unless the API provides that evidence.
- Present invalid/expired credentials, pending or insufficient access, network
  errors, and an empty accessible queue as distinct states where detectable.
  An ambiguous not-found response must say unavailable or inaccessible rather
  than claim that a repository does not exist.
- On token replacement, verify the identity, invalidate queue/API caches, and
  establish new notification baselines. Namespace caches and notification state
  by account ID; ignore in-flight results from the previous credential generation.
  Token removal stops polling, clears credential/cache/notification state, and
  resets the badge. Preserve local notes unless the user explicitly deletes them.

### Credential handling
The token persists in `chrome.storage.local` with trusted-context access enforced
before it is written. Worker ownership describes the application's code boundary:
trusted extension pages technically retain access to this storage area. Only the
options UI handles initial token input; all subsequent credential reads and API
calls belong to the worker. Never return credentials to content scripts, inject
them into page context, or log them. This access restriction is not encryption
at rest or protection against a compromised trusted extension page.

## 7. Manifest & Permissions

| Entry | Why |
|---|---|
| `host_permissions: https://api.github.com/*` | GraphQL/REST calls from the worker |
| `permissions: storage` | Trusted-context token, settings, notes, queue cache, notification state |
| `permissions: alarms` | Scheduled polling (MV3 workers can't use long timers) |
| `optional_permissions: notifications` | Review-request and reply alerts; request when enabled by the user |
| `content_scripts` matching `https://github.com/*` | Lightweight navigation bootstrap; PR UI activates only on PR routes |

The static content-script declaration supplies GitHub injection access; no separate
`github.com` host permission is needed for this design. Explain the site-wide
bootstrap in the listing: it detects entry into PR routes without a document
reload. Authenticated network calls target `api.github.com` from the worker.

## 8. Key Design Decisions

- **API over DOM scraping.** Thread data comes from GraphQL, not from reading
  the page, so the core feature does not depend on GitHub's markup.
- **One file for selectors.** `domAnchors.ts` is the only place that knows
  GitHub's DOM; when GitHub changes its UI, one file gets fixed.
- **Shadow DOM styling.** Scopes selectors; explicitly set inherited typography
  and theme variables on the host. It is not a credential/security boundary.
- **Worker owns authenticated operations.** Trusted-context storage access and
  runtime-validated, sender-checked messages enforce the content-script boundary.
- **Graceful degradation.** If a selector breaks, the panel still lists threads
  and offers comment permalinks. Partial/stale API data is explicitly labeled.
- **Respect rate limits.** Poll conservatively, back off using response
  headers, and skip polling when no token is set.

## 9. Build Phases

1. **Scaffold** — Vite + CRXJS + React + TS; manifest, empty content script,
   worker, popup, options. Confirm bootstrap entry from non-PR GitHub pages.
2. **Auth & API client** — trusted storage initialization, validated messages,
   single-token coverage UI, account identity, Zod schemas, and fully paginated
   thread/comment fetching with partial/error states.
3. **Panel injection** — idempotent Shadow DOM mount, GitHub-wide navigation
   bootstrap, route cleanup, stale-response rejection, and unresolved-thread UI.
4. **Thread jump** — `domAnchors.ts` + `threadJump.ts`, scroll and highlight.
5. **Notes** — `notesStore`, note editor, done/not-done state, summary counts.
6. **Queue & badge** — explicit request-based classification, paginated discovery,
   persisted snapshots, alarm recovery, freshness indicators, and badge count.
7. **Notifications & settings** — monitored PR lifecycle, complete silent
   baselines, reply-ID tracking, persisted delivery ledger, optional notification
   permission, interval and independent request/reply alert toggles.
8. **Hardening** — rate-limit handling, expired/invalid token states, empty
   states, large PRs (many threads), selector-failure fallbacks.
9. **Package & listing** — icons, screenshots, permission justification, submit.

## 10. Testing Strategy

- **Vitest:** recorded API fixtures and runtime message validation; queue
  classification for first-review requests, direct/team requests, drafts,
  approved PRs with no outstanding requests, and requested changes alongside
  another pending reviewer. Unresolved threads alone must not qualify authored PRs.
- **Pagination:** more than 100 threads, multipage comments and review requests,
  search truncation, partial GraphQL errors, and interrupted later pages. Assert
  incomplete indicators and preservation of previous successful snapshots and
  notification checkpoints.
- **Security/storage integration:** content scripts cannot read local credentials
  or invoke credential-management operations; untrusted senders and malformed
  payloads are rejected; initialization failure prevents credential persistence.
  Verify account isolation and rejection of old results after token replacement.
- **Playwright:** load the unpacked extension against deterministic API fixtures;
  navigate repository homepage/PR list → PR → another PR → non-PR without reloads.
  Assert one panel, correct data, cleanup, remount after DOM replacement, and no
  stale response from a previous route. Keep a public-PR live smoke test separate.
- **Notification integration:** silent initial baselines, new replies versus
  edits/new threads/own replies, monitoring after review submission, re-requests,
  repeated polls, worker restart, interrupted delivery, incomplete refreshes,
  permission denial, re-enablement, and closure/access loss. Check persisted
  deduplication and the documented crash-delivery limitation.
- **Manual checklist:** Conversation/Files changed navigation, unavailable jump
  targets, expired token, restricted repository coverage, empty accessible queue,
  no network, rate limits, browser restart, and storage pressure.

## 11. Open Questions

- Future versions: opt-in note sharing and write-scoped thread resolution require
  a separate privacy/permissions design; v1 stays local-only and read-only.
- Default polling interval. Notifications default off and request optional
  permission only when enabled; review-request and reply alerts have separate toggles.
- Support the Files changed tab fully in v1, or ship Conversation-tab support first?

## 12. Platform References

- [Chrome storage access levels](https://developer.chrome.com/docs/extensions/reference/api/storage)
- [Chrome content-script injection](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts)
- [GitHub GraphQL pagination](https://docs.github.com/en/graphql/guides/using-pagination-in-the-graphql-api)
- [GitHub review search semantics](https://docs.github.com/en/search-github/searching-on-github/searching-issues-and-pull-requests#search-by-pull-request-review-status-and-reviewer)
- [GitHub fine-grained token limitations](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)
