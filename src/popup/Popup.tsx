import { useState } from "react";
import { Brand } from "../shared/Brand";
import { useAuthStatus } from "../shared/useAuthStatus";
import { AuthErrorMessage } from "../shared/AuthErrorMessage";

export function Popup() {
  const { status, error: statusError } = useAuthStatus();
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function openSettings() {
    setOpening(true);
    setError(null);
    try {
      await chrome.runtime.openOptionsPage();
    } catch {
      setError("Settings could not open. Please try again.");
    } finally {
      setOpening(false);
    }
  }

  return (
    <main className="w-90 p-5">
      <Brand />
      <section
        className="mt-6 rounded-2xl border border-line bg-white p-5"
        aria-labelledby="queue-heading"
      >
        <span className="text-[10px] font-semibold tracking-[0.14em] text-muted uppercase">
          {status?.connected ? `@${status.account.login}` : "Getting started"}
        </span>
        <h2
          id="queue-heading"
          className="mt-2 text-xl leading-tight font-semibold tracking-tight"
        >
          Review queues are coming next
        </h2>
        <p className="mt-3 text-sm leading-relaxed text-muted">
          {status === null ? (statusError ? "Connection status is unavailable." : "Loading saved connection…")
            : !status.connected ? "Connect your GitHub account in settings to get started."
            : status.health === "verified" ? "Your GitHub account is saved. Repository coverage depends on the configured token’s access."
            : "Your account is saved, but its credential needs a recheck. Open settings to verify or replace it."}
        </p>
        {statusError && <AuthErrorMessage error={statusError} />}
        <button
          type="button"
          onClick={() => void openSettings()}
          disabled={opening}
          className="mt-5 w-full rounded-lg bg-accent px-4 py-2.5 text-sm font-semibold text-white hover:bg-ink disabled:opacity-60"
        >
          {opening ? "Opening settings…" : "Open settings"}
        </button>
        {error && (
          <p role="alert" className="mt-3 text-sm text-red-700">
            {error}
          </p>
        )}
      </section>
      <p className="mt-4 text-center text-xs text-muted">
        Development preview · Queues are not implemented yet
      </p>
    </main>
  );
}
