import { useEffect, useState } from "react";
import { ReviewPreview } from "./ReviewPreview";
import { Brand } from "../shared/Brand";
import { AuthErrorMessage } from "../shared/AuthErrorMessage";
import { requestAuth } from "../shared/auth";
import type { AuthError, AuthRequest, RepositoryResult } from "../shared/auth";
import { useAuthStatus } from "../shared/useAuthStatus";
import { version } from "../../package.json";

const button = "rounded-lg border border-line px-4 py-2 text-sm font-semibold hover:bg-paper disabled:opacity-60";
const primary = "rounded-lg bg-accent px-4 py-2.5 text-sm font-semibold text-white hover:bg-ink disabled:opacity-60";
const input = "mt-2 w-full rounded-lg border border-line bg-white px-3 py-2.5 text-sm disabled:opacity-60";

export function Options() {
  const { status, error: statusError, refresh } = useAuthStatus();
  const [token, setToken] = useState("");
  const [replacing, setReplacing] = useState(false);
  const [busy, setBusy] = useState<AuthRequest["type"] | null>(null);
  const [error, setError] = useState<AuthError | null>(null);
  const [notice, setNotice] = useState("");
  const [repository, setRepository] = useState("");
  const [repoError, setRepoError] = useState<AuthError | null>(null);
  const [repoResult, setRepoResult] = useState<RepositoryResult | null>(null);
  const revision = status?.connected ? status.revision : null;
  useEffect(() => { setRepoResult(null); setRepoError(null); }, [revision]);

  async function perform(request: AuthRequest) {
    setBusy(request.type);
    const repoCheck = request.type === "auth.checkRepository";
    if (repoCheck) { setRepoError(null); setRepoResult(null); }
    else { setError(null); setNotice(""); }
    try {
      const reply = await requestAuth(request);
      if (!reply.ok) {
        if (repoCheck) setRepoError(reply.error);
        else setError(reply.error);
      } else if (repoCheck) {
        setRepoResult(reply.repository ?? null);
      } else {
        setReplacing(false);
        setNotice(request.type === "auth.disconnect" ? "Saved connection removed."
          : request.type === "auth.recheck" ? "Connection verified." : "GitHub account verified and saved.");
      }
      await refresh();
    } finally {
      if (request.type === "auth.connect") setToken("");
      setBusy(null);
    }
  }

  function checkRepository() {
    const parts = repository.trim().split("/");
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      setRepoResult(null); setRepoError({ code: "INVALID_REQUEST" }); return;
    }
    void perform({ type: "auth.checkRepository", owner: parts[0], repo: parts[1] });
  }

  return (
    <main className="mx-auto max-w-2xl px-6 py-12 sm:py-20">
      <Brand />
      <div className="mt-12">
        <p className="text-xs font-semibold tracking-[0.16em] text-muted uppercase">Settings</p>
        <h2 className="mt-3 text-3xl font-semibold tracking-tight">A home for your reviews.</h2>
        <p className="mt-3 max-w-lg text-base leading-relaxed text-muted">
          Keep track of conversations, review notes, and what needs your attention on GitHub.
        </p>
      </div>
      <section className="mt-8 rounded-2xl border border-line bg-white p-6 sm:p-8" aria-labelledby="connection-heading" aria-busy={busy !== null}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 id="connection-heading" className="text-lg font-semibold">GitHub connection</h3>
          <span className="rounded-full bg-paper px-3 py-1 text-xs font-medium text-muted">
            {status === null ? (statusError ? "Status unavailable" : "Loading…") : !status.connected ? "Not connected"
              : status.health === "verified" ? "Verified" : status.health === "invalid" ? "Needs attention" : "Validity unknown"}
          </span>
        </div>
        {statusError && <><AuthErrorMessage error={statusError} /><button className={`${button} mt-3`} onClick={() => void refresh()}>Retry status</button></>}
        {status?.connected && (
          <div className="mt-4">
            <p className="text-sm font-semibold">Saved account: @{status.account.login}</p>
            <p className="mt-1 text-xs leading-relaxed text-muted">Last verified {new Date(status.verifiedAt).toLocaleString()}.</p>
            {status.health !== "verified" && <p className="mt-2 text-sm text-muted">
              {status.health === "invalid" ? "GitHub rejected the saved credential. Replace it or recheck after updating access."
                : "The last check could not verify this credential. Your previously verified account has been preserved."}
            </p>}
            <div className="mt-4 flex flex-wrap gap-2">
              <button className={button} disabled={!!busy} onClick={() => void perform({ type: "auth.recheck" })}>
                {busy === "auth.recheck" ? "Checking…" : "Recheck connection"}
              </button>
              <button className={button} disabled={!!busy} onClick={() => { setReplacing(true); setError(null); setNotice(""); }}>Replace token</button>
              <button className={button} disabled={!!busy} onClick={() => { setToken(""); void perform({ type: "auth.disconnect" }); }}>
                {busy === "auth.disconnect" ? "Disconnecting…" : "Disconnect"}
              </button>
            </div>
          </div>
        )}
        {status !== null && (!status.connected || replacing) && (
          <form className="mt-6" onSubmit={event => { event.preventDefault(); void perform({ type: "auth.connect", token }); }}>
            <label htmlFor="github-token" className="text-sm font-medium">Fine-grained personal access token</label>
            <input id="github-token" type="password" autoComplete="off" spellCheck={false} autoCapitalize="none"
              value={token} onChange={event => setToken(event.target.value)} required maxLength={4096}
              disabled={!!busy} className={input} aria-describedby="token-help" />
            <p id="token-help" className="mt-2 text-xs leading-relaxed text-muted">
              Stored only in this Chrome profile. The saved token is never shown here. A failed replacement keeps the existing connection.
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              <button className={primary} disabled={!!busy || !token.trim()} type="submit">
                {busy === "auth.connect" ? "Verifying…" : "Verify and save"}
              </button>
              {replacing && <button className={button} type="button" disabled={!!busy} onClick={() => { setToken(""); setReplacing(false); }}>Cancel</button>}
            </div>
          </form>
        )}
        {error && <AuthErrorMessage error={error} />}
        {notice && <p role="status" className="mt-3 text-sm text-accent">{notice}</p>}
        <div className="mt-6 border-t border-line pt-5 text-sm leading-relaxed text-muted">
          <a className="font-semibold text-accent underline underline-offset-4" href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noreferrer">Create a fine-grained token on GitHub</a>
          <ol className="mt-3 list-decimal space-y-2 pl-5">
            <li>Choose the resource owner and the repositories you want to review.</li>
            <li>Set repository permission <strong>Pull requests: Read-only</strong>. Metadata read access is included automatically.</li>
            <li>Choose an expiration date. An organization may require approval before its private repositories become accessible.</li>
          </ol>
          <p className="mt-4">Identity verification does not verify repository access. Coverage is limited to this token’s accessible repositories; one fine-grained token cannot cover private repositories across multiple resource owners.</p>
          <p className="mt-3 text-xs">Disconnect removes the local credential; revoke it in GitHub settings if you also want to invalidate it on GitHub.</p>
        </div>
      </section>
      {status?.connected && (
        <section className="mt-6 rounded-2xl border border-line bg-white p-6 sm:p-8" aria-labelledby="repository-heading">
          <h3 id="repository-heading" className="text-lg font-semibold">Check repository access <span className="font-normal text-muted">(optional)</span></h3>
          <form className="mt-4" onSubmit={event => { event.preventDefault(); checkRepository(); }}>
            <label htmlFor="repository" className="text-sm font-medium">Repository (owner/repo)</label>
            <input id="repository" className={input} value={repository} onChange={event => { setRepository(event.target.value); setRepoResult(null); setRepoError(null); }}
              placeholder="octocat/hello-world" autoComplete="off" spellCheck={false} autoCapitalize="none" required disabled={!!busy} maxLength={201} />
            <button className={`${button} mt-4`} disabled={!!busy || !repository.trim()} type="submit">
              {busy === "auth.checkRepository" ? "Checking access…" : "Check access"}
            </button>
          </form>
          {repoError && <AuthErrorMessage error={repoError} />}
          {repoResult && <p role="status" className="mt-3 text-sm text-accent">
            Pull-request access succeeded for {repoResult.owner}/{repoResult.repo} at {new Date(repoResult.checkedAt).toLocaleString()}.
          </p>}
          <p className="mt-3 text-xs leading-relaxed text-muted">An empty repository can pass. Success applies only to this repository at this time. Public repository access does not prove permission to read private repositories.</p>
        </section>
      )}
      {status?.connected && status.health !== "invalid" && <ReviewPreview key={status.revision} revision={status.revision} />}
      <p className="mt-6 text-xs leading-relaxed text-muted">Version {version} · Development preview · Thread jumping is coming next.</p>
    </main>
  );
}
