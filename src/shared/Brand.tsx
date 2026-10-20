export function Brand() {
  return (
    <header className="flex items-center gap-3">
      <img
        src="/icons/icon-48.png"
        alt=""
        width="40"
        height="40"
        className="rounded-xl"
      />
      <div>
        <p className="text-[10px] font-semibold tracking-[0.18em] text-muted uppercase">
          For GitHub
        </p>
        <h1 className="text-base font-semibold tracking-tight">
          PR Review Companion
        </h1>
      </div>
    </header>
  );
}
