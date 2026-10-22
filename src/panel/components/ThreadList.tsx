import { useState } from "react";
import type { ReviewData, ReviewThread } from "../../shared/reviews";
import type { PrIdentity } from "../../shared/prUrl";
import { discussionLinks, type DiscussionLink } from "../../shared/threadLinks";

export function groupUnresolved(threads: ReviewThread[]) {
  const files = new Map<string, ReviewThread[]>();
  for (const thread of threads) {
    if (thread.isResolved) continue;
    const group = files.get(thread.path) ?? [];
    group.push(thread);
    files.set(thread.path, group);
  }
  return [...files].sort(([a], [b]) => a.localeCompare(b));
}
function ThreadItem({
  thread,
  pr,
  onJump,
}: {
  thread: ReviewThread;
  pr: PrIdentity;
  onJump: (links: DiscussionLink[]) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const first = thread.comments[0];
  const line = thread.line ?? thread.originalLine;
  const links = discussionLinks(thread.comments, pr);
  return (
    <div className="thread">
      <details onToggle={(event) => setExpanded(event.currentTarget.open)}>
        <summary>
          <span className="thread-meta">
            {line === null
              ? "File discussion"
              : `${thread.line === null ? "Original line" : "Line"} ${line}`}
            {thread.isOutdated ? " · Outdated" : ""} · {thread.comments.length}{" "}
            published comments
          </span>
          <span className="thread-author">
            {first?.author
              ? `@${first.author.login}`
              : first
                ? "Deleted author"
                : "No published comments loaded"}
          </span>
          {first && (
            <span className="excerpt">
              {first.body.length > 180
                ? `${first.body.slice(0, 180)}…`
                : first.body || "(Empty comment)"}
            </span>
          )}
        </summary>
        {expanded && (
          <ol className="comments">
            {thread.comments.map((comment) => (
              <li key={comment.id}>
                <p className="thread-author">
                  {comment.author
                    ? `@${comment.author.login}`
                    : "Deleted author"}
                </p>
                <p className="comment-body">
                  {comment.body || "(Empty comment)"}
                </p>
                <a href={comment.url} target="_blank" rel="noopener noreferrer">
                  Open comment on GitHub
                </a>
              </li>
            ))}
          </ol>
        )}
      </details>
      <div className="thread-actions">
        <button
          type="button"
          disabled={!links.length}
          onClick={() => onJump(links)}
        >
          Jump to discussion
        </button>
        {!links.length && (
          <p className="meta">
            No valid published-comment permalink is available.
          </p>
        )}
      </div>
    </div>
  );
}
export function ThreadList({
  data,
  complete,
  pr,
  onJump,
}: {
  data: ReviewData;
  complete: boolean;
  pr: PrIdentity;
  onJump: (links: DiscussionLink[]) => void;
}) {
  const groups = groupUnresolved(data.threads);
  if (!groups.length)
    return (
      <p className="mt-3 text-sm">
        {complete
          ? "No unresolved review threads."
          : "No unresolved threads loaded yet. Results are incomplete."}
      </p>
    );
  return (
    <div className="thread-list">
      {groups.map(([path, threads]) => (
        <section key={path} aria-label={`Threads in ${path}`}>
          <h3 className="file-path">{path}</h3>
          {threads.map((thread) => (
            <ThreadItem
              key={thread.id}
              thread={thread}
              pr={pr}
              onJump={onJump}
            />
          ))}
        </section>
      ))}
    </div>
  );
}
