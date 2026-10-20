import { Brand } from "../shared/Brand";
import { version } from "../../package.json";

export function Options() {
  return (
    <main className="mx-auto max-w-2xl px-6 py-12 sm:py-20">
      <Brand />
      <div className="mt-12">
        <p className="text-xs font-semibold tracking-[0.16em] text-muted uppercase">
          Settings
        </p>
        <h2 className="mt-3 text-3xl font-semibold tracking-tight">
          A home for your reviews.
        </h2>
        <p className="mt-3 max-w-lg text-base leading-relaxed text-muted">
          Keep track of conversations, review notes, and what needs your
          attention on GitHub.
        </p>
      </div>
      <section
        className="mt-8 rounded-2xl border border-line bg-white p-6 sm:p-8"
        aria-labelledby="connection-heading"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 id="connection-heading" className="text-lg font-semibold">
            GitHub connection
          </h3>
          <span className="rounded-full bg-paper px-3 py-1 text-xs font-medium text-muted">
            Not connected
          </span>
        </div>
        <p className="mt-4 text-sm leading-relaxed text-muted">
          Connection settings arrive in the next step. This development preview
          does not collect credentials or access GitHub data.
        </p>
      </section>
      <p className="mt-6 text-xs leading-relaxed text-muted">
        Version {version} · Development preview
      </p>
    </main>
  );
}
