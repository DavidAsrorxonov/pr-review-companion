import { useEffect, useRef, useState } from 'react';
import { errorMessages } from '../shared/auth';
import { counts, parsePrUrl, requestReviews, reviewFailure } from '../shared/reviews';
import type { ReviewData, ReviewError, ReviewReply } from '../shared/reviews';

const button = 'rounded-lg border border-line px-4 py-2 text-sm font-semibold hover:bg-paper disabled:opacity-60';
function ErrorMessage({ error }: { error: ReviewError }) {
  const messages = {
    ...errorMessages,
    INVALID_REQUEST: 'Enter a GitHub pull-request URL, such as https://github.com/owner/repo/pull/123.',
    REPOSITORY_UNAVAILABLE: 'This pull request was not found or is inaccessible with the saved token.',
    INTERRUPTED: 'The load was interrupted or expired. Load the PR again to restart pagination.',
    CANCELLED: 'Loading was cancelled.', RESOURCE_LIMIT: 'This PR exceeded the preview’s 8 MiB limit. Results are incomplete.',
    INCOMPLETE: 'GitHub could not return a complete page. Results are incomplete; try loading again.',
    BUSY: 'Another request is in progress. Try loading again when it finishes.',
  };
  return <p role="alert" className="mt-3 text-sm text-muted">{messages[error.code]}
    {error.retryAt !== undefined && <> Retry after {new Date(error.retryAt).toLocaleString()}.</>}
  </p>;
}
function Summary({ data, provisional = false }: { data: ReviewData; provisional?: boolean }) {
  const totals = counts(data);
  return <div className="mt-3 text-sm leading-relaxed">
    <a className="font-semibold text-accent underline underline-offset-4" href={data.pr.url} target="_blank" rel="noreferrer">{data.pr.title}</a>
    <p className="mt-1 text-xs text-muted">#{data.pr.number} · {data.pr.state.toLowerCase()}{data.pr.isDraft ? ' · draft' : ''}</p>
    <p className="mt-2">{provisional ? 'Provisional counts: ' : ''}{totals.total} threads · {totals.resolved} resolved · {totals.unresolved} unresolved · {totals.outdated} outdated · {totals.comments} published comments</p>
  </div>;
}
export function ReviewPreview({ revision }: { revision: string }) {
  const [url, setUrl] = useState('');
  const [reply, setReply] = useState<ReviewReply | null>(null);
  const [busy, setBusy] = useState(false);
  const [cancelled, setCancelled] = useState(false);
  const sequence = useRef(0);
  const jobId = useRef<string | undefined>(undefined);
  const loading = useRef(false);
  useEffect(() => () => {
    sequence.current++;
    if (loading.current) void requestReviews({ type: 'reviews.cancel', jobId: jobId.current });
  }, []);
  async function load(refresh = false) {
    const pr = parsePrUrl(url);
    if (!pr) { setReply(reviewFailure('INVALID_REQUEST')); return; }
    const current = ++sequence.current;
    setBusy(true); loading.current = true; setCancelled(false); setReply(null); jobId.current = undefined;
    try {
      let result = await requestReviews({ type: 'reviews.load', pr, refresh });
      while (current === sequence.current) {
        if (result.revision && result.revision !== revision) { setReply(null); break; }
        setReply(result); jobId.current = result.jobId;
        if (result.state !== 'loading' || !result.jobId) break;
        result = await requestReviews({ type: 'reviews.continue', jobId: result.jobId });
      }
    } finally {
      if (current === sequence.current) { setBusy(false); loading.current = false; jobId.current = undefined; }
    }
  }
  async function cancel() {
    sequence.current++; loading.current = false;
    const active = jobId.current; jobId.current = undefined;
    setBusy(false); setCancelled(true);
    await requestReviews({ type: 'reviews.cancel', jobId: active });
  }
  return <section className="mt-6 rounded-2xl border border-line bg-white p-6 sm:p-8" aria-labelledby="review-preview-heading">
    <h3 id="review-preview-heading" className="text-lg font-semibold">Review data preview</h3>
    <p className="mt-3 text-sm leading-relaxed text-muted">Load one pull request to inspect its review counts. Repository access checks use a different API; passing that check does not guarantee GraphQL review access.</p>
    <form className="mt-4" onSubmit={event => { event.preventDefault(); void load(); }}>
      <label htmlFor="pr-url" className="text-sm font-medium">GitHub pull-request URL</label>
      <input id="pr-url" type="url" value={url} onChange={event => { setUrl(event.target.value); setReply(null); setCancelled(false); }}
        placeholder="https://github.com/owner/repo/pull/123" required maxLength={2048} disabled={busy} autoComplete="off" spellCheck={false}
        className="mt-2 w-full rounded-lg border border-line bg-white px-3 py-2.5 text-sm disabled:opacity-60" />
      <div className="mt-4 flex flex-wrap gap-2">
        <button className={button} disabled={busy || !url.trim()} type="submit">{busy ? 'Loading PR…' : 'Load PR'}</button>
        <button className={button} disabled={busy || !url.trim()} type="button" onClick={() => void load(true)}>Refresh</button>
        {busy && <button className={button} type="button" onClick={() => void cancel()}>Cancel</button>}
      </div>
    </form>
    <div aria-live="polite" aria-atomic="true">
      {cancelled && <p className="mt-3 text-sm text-muted">Loading cancelled. Partial counts are not a complete result.</p>}
      {reply?.snapshot && <div className="mt-5 border-t border-line pt-4">
        <p className="text-xs font-semibold text-muted">{reply.freshness === 'stale' ? 'Last complete result · stale' : 'Complete result · fresh'} · {reply.persistence === 'cached' ? 'cached locally' : 'uncached'}</p>
        <Summary data={reply.snapshot.data} />
        <p className="mt-2 text-xs text-muted">Last successful fetch: {new Date(reply.snapshot.fetchedAt).toLocaleString()}.</p>
      </div>}
      {reply?.partial && !reply.complete && <div className="mt-5 border-t border-line pt-4">
        <p className="text-xs font-semibold text-muted">Current {busy ? 'load' : 'incomplete result'}</p>
        <Summary data={reply.partial} provisional />
      </div>}
      {reply?.progress && !reply.complete && <p className="mt-3 text-xs text-muted">
        {reply.progress.pages} pages received · {reply.progress.threads} threads · {reply.progress.comments} published comments loaded. {busy ? 'Continuing pagination…' : 'Pagination did not finish.'}
      </p>}
    </div>
    {reply?.error && !cancelled && <ErrorMessage error={reply.error} />}
    {reply?.warning && <p role="status" className="mt-3 text-sm text-muted">The complete result could not be saved locally. It is available only in this preview.</p>}
    <p className="mt-4 text-xs leading-relaxed text-muted">Outdated threads can also be resolved or unresolved. Counts are provisional until every page is loaded. A complete traversal is not an atomic snapshot while discussions change. Fresh cached results are reused for 60 seconds; Refresh requests current data, subject to GitHub rate limits.</p>
  </section>;
}
