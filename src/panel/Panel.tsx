import { useEffect, useRef, useSyncExternalStore } from "react";
import type { PanelSession } from "./session";
import { counts } from "../shared/reviews";
import type { ReviewData, ReviewError } from "../shared/reviews";
import { errorMessages } from "../shared/auth";
import { ThreadList } from "./components/ThreadList";
import type { ThreadJump } from "../content/threadJump";
import type { PrIdentity } from "../shared/prUrl";
import { NotesList } from "./components/NotesList";
import type { NotesSession } from "./notesSession";

function Failure({ error }: { error: ReviewError }) {
  const messages = {
    ...errorMessages,
    INVALID_REQUEST:
      "This PR could not be read. Reload the page and try again.",
    REPOSITORY_UNAVAILABLE:
      "This PR was not found or is inaccessible with the saved token.",
    INTERRUPTED:
      "The worker restarted or this load expired. Load reviews to start again.",
    CANCELLED: "Loading was cancelled.",
    RESOURCE_LIMIT:
      "This PR exceeded the preview size limit. Results are incomplete.",
    INCOMPLETE:
      "GitHub did not return a complete page. Load reviews to try again.",
    BUSY: "Other review requests are running. Load reviews again when they finish.",
  };
  return (
    <p className="notice" role="alert">
      {messages[error.code]}
      {error.retryAt !== undefined && (
        <> Retry after {new Date(error.retryAt).toLocaleString()}.</>
      )}
      {error.code === "WORKER_UNAVAILABLE" && (
        <> Reload this GitHub tab after reloading the extension.</>
      )}
    </p>
  );
}
function Summary({ data }: { data: ReviewData }) {
  const totals = counts(data);
  return (
    <>
      <a
        className="pr-title"
        href={data.pr.url}
        target="_blank"
        rel="noreferrer"
      >
        {data.pr.title}
      </a>
      <p className="meta">
        #{data.pr.number} · {data.pr.state.toLowerCase()}
        {data.pr.isDraft ? " · draft" : ""}
      </p>
      <p className="mt-2 text-sm">
        {totals.unresolved} unresolved · {totals.resolved} resolved ·{" "}
        {totals.outdated} outdated
      </p>
    </>
  );
}
export function Panel({
  session,
  jump,
  pr,
  notes,
}: {
  session: PanelSession;
  jump: ThreadJump;
  pr: PrIdentity;
  notes: NotesSession;
}) {
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const jumping = useSyncExternalStore(jump.subscribe, jump.getSnapshot);
  const launcher = useRef<HTMLButtonElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (state.open) heading.current?.focus();
  }, [state.open]);
  function close() {
    jump.cancel();
    session.close();
    launcher.current?.focus();
  }
  function load(refresh = false) {
    jump.cancel();
    void session.load(refresh);
  }
  const usable = state.status?.connected && state.status.health !== "invalid";
  const reply = !state.checking ? state.reply : undefined;
  const data = reply?.partial ?? reply?.snapshot?.data;
  return (
    <>
      <div
        className="jump-announcement"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {jumping.message}
      </div>
      <button
        ref={launcher}
        className="launcher"
        type="button"
        aria-expanded={state.open}
        aria-controls="prrc-drawer"
        onClick={() => {
          if (state.open) close();
          else {
            jump.cancel();
            session.open();
          }
        }}
      >
        Review Companion
      </button>
      {state.open && (
        <aside
          id="prrc-drawer"
          className="drawer"
          aria-labelledby="prrc-heading"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              close();
            }
          }}
        >
          <header className="drawer-header">
            <h2 ref={heading} tabIndex={-1} id="prrc-heading">
              PR Review Companion
            </h2>
            <button type="button" onClick={close}>
              Close
            </button>
          </header>
          <div className="drawer-scroll">
            <div className="controls">
              <button
                type="button"
                onClick={() => load()}
                disabled={!usable || state.busy || state.checking}
              >
                Load reviews
              </button>
              <button
                type="button"
                onClick={() => load(true)}
                disabled={!usable || state.busy || state.checking}
              >
                Refresh
              </button>
              {state.busy && (
                <button type="button" onClick={() => session.cancel()}>
                  Cancel loading
                </button>
              )}
              <button type="button" onClick={() => void session.openSettings()}>
                Open settings
              </button>
            </div>
            <div role="status" className="meta mt-3">
              {state.checking
                ? "Checking connection…"
                : state.busy
                  ? "Loading review pages…"
                  : state.notice}
              {!state.checking && reply?.progress && (
                <>
                  {" "}
                  {reply.progress.pages} pages · {reply.progress.threads}{" "}
                  threads · {reply.progress.comments} published comments loaded.
                </>
              )}
            </div>
            {!state.checking && state.status && !usable && (
              <p className="notice">
                {state.status.connected
                  ? "GitHub rejected the saved credential. Open settings to recheck or replace it."
                  : "Connect your GitHub account in settings to load reviews."}
              </p>
            )}
            {!state.checking &&
              state.status?.connected &&
              state.status.health === "unknown" && (
                <p className="notice">
                  The saved connection’s current validity is unknown.
                </p>
              )}
            {state.error && <Failure error={state.error} />}
            {(jumping.state === "searching" ||
              jumping.state === "unavailable") && (
              <div className="notice">
                <p>{jumping.message}</p>
                {jumping.state === "unavailable" && jumping.url && (
                  <a
                    href={jumping.url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Open comment on GitHub
                  </a>
                )}
              </div>
            )}
            {reply?.error && <Failure error={reply.error} />}
            {reply?.warning && (
              <p className="notice">This result could not be cached locally.</p>
            )}
            {reply?.snapshot && (
              <section className="snapshot" aria-label="Last complete snapshot">
                <p className="meta">
                  {reply.freshness === "stale"
                    ? "Last complete result · stale"
                    : "Complete result · fresh"}{" "}
                  ·{" "}
                  {reply.persistence === "cached"
                    ? "cached locally"
                    : "uncached"}
                </p>
                <Summary data={reply.snapshot.data} />
                <p className="meta mt-2">
                  Last successful fetch:{" "}
                  {new Date(reply.snapshot.fetchedAt).toLocaleString()}.
                </p>
              </section>
            )}
            {reply?.partial && (
              <section className="snapshot" aria-label="Provisional results">
                <p className="meta">
                  Current load · provisional counts · incomplete
                </p>
                <Summary data={reply.partial} />
              </section>
            )}
            <NotesList session={notes} checking={state.checking} />
            {data && (
              <>
                <h2 className="list-heading">
                  Unresolved threads
                  {!reply?.complete ? " · incomplete load" : ""}
                </h2>
                <ThreadList
                  data={data}
                  complete={!!reply?.complete}
                  pr={pr}
                  onJump={(links) => {
                    if (reply?.revision) void jump.jump(links, reply.revision);
                  }}
                />
              </>
            )}
            <p className="footnote">
              Outdated threads may also be resolved or unresolved. Counts are
              final only when pagination completes. Discussions may change
              during a load.
            </p>
          </div>
        </aside>
      )}
    </>
  );
}
