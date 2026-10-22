import { useState } from 'react';
import type { ReviewData, ReviewThread } from '../../shared/reviews';

export function groupUnresolved(threads: ReviewThread[]) {
  const files = new Map<string, ReviewThread[]>();
  for (const thread of threads) {
    if (thread.isResolved) continue;
    const group = files.get(thread.path) ?? [];
    group.push(thread); files.set(thread.path, group);
  }
  return [...files].sort(([a], [b]) => a.localeCompare(b));
}
function ThreadItem({ thread }: { thread: ReviewThread }) {
  const [expanded, setExpanded] = useState(false);
  const first = thread.comments[0];
  const line = thread.line ?? thread.originalLine;
  return <details className="thread" onToggle={event => setExpanded(event.currentTarget.open)}>
    <summary>
      <span className="thread-meta">{line === null ? 'File discussion' : `${thread.line === null ? 'Original line' : 'Line'} ${line}`}
        {thread.isOutdated ? ' · Outdated' : ''} · {thread.comments.length} published comments</span>
      <span className="thread-author">{first?.author ? `@${first.author.login}` : first ? 'Deleted author' : 'No published comments loaded'}</span>
      {first && <span className="excerpt">{first.body.length > 180 ? `${first.body.slice(0, 180)}…` : first.body || '(Empty comment)'}</span>}
    </summary>
    {expanded && <ol className="comments">
      {thread.comments.map(comment => <li key={comment.id}>
        <p className="thread-author">{comment.author ? `@${comment.author.login}` : 'Deleted author'}</p>
        <p className="comment-body">{comment.body || '(Empty comment)'}</p>
        <a href={comment.url} target="_blank" rel="noreferrer">Open comment on GitHub</a>
      </li>)}
    </ol>}
  </details>;
}
export function ThreadList({ data, complete }: { data: ReviewData; complete: boolean }) {
  const groups = groupUnresolved(data.threads);
  if (!groups.length) return <p className="mt-3 text-sm">{complete ? 'No unresolved review threads.' : 'No unresolved threads loaded yet. Results are incomplete.'}</p>;
  return <div className="thread-list">
    {groups.map(([path, threads]) => <section key={path} aria-label={`Threads in ${path}`}>
      <h3 className="file-path">{path}</h3>
      {threads.map(thread => <ThreadItem key={thread.id} thread={thread} />)}
    </section>)}
  </div>;
}
