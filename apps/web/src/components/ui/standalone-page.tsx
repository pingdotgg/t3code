import type { ReactNode } from "react";

const backdropClassNames = {
  pairing:
    "absolute inset-x-0 top-0 h-44 bg-[radial-gradient(44rem_16rem_at_top,color-mix(in_srgb,var(--color-emerald-500)_14%,transparent),transparent)]",
  error:
    "absolute inset-x-0 top-0 h-44 bg-[radial-gradient(44rem_16rem_at_top,color-mix(in_srgb,var(--color-red-500)_16%,transparent),transparent)]",
  brand:
    "absolute inset-x-0 top-0 h-72 bg-[radial-gradient(48rem_20rem_at_top,color-mix(in_srgb,var(--color-blue-500)_12%,transparent),transparent)]",
};

export function StandalonePage({
  tone,
  masthead,
  children,
}: {
  readonly tone: keyof typeof backdropClassNames;
  readonly masthead?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    // #root never scrolls, so the page owns its scroll. Safe centering keeps a
    // card taller than the viewport anchored at the top instead of clipping it.
    <div className="relative h-full overflow-hidden bg-background text-foreground">
      <div className="pointer-events-none absolute inset-0 opacity-80" aria-hidden>
        <div className={backdropClassNames[tone]} />
        {tone === "pairing" ? (
          <div className="absolute inset-y-0 left-0 w-72 bg-[radial-gradient(28rem_18rem_at_left,color-mix(in_srgb,var(--color-sky-500)_10%,transparent),transparent)]" />
        ) : null}
        <div
          className={
            tone === "brand"
              ? "absolute inset-0 bg-[linear-gradient(145deg,color-mix(in_srgb,var(--background)_94%,var(--color-black))_0%,var(--background)_62%)]"
              : "absolute inset-0 bg-[linear-gradient(145deg,color-mix(in_srgb,var(--background)_90%,var(--color-black))_0%,var(--background)_55%)]"
          }
        />
      </div>

      <div className="relative flex h-full items-center-safe justify-center overflow-y-auto scrollbar-gutter-both px-4 py-10 sm:px-6">
        <section
          className={`relative w-full max-w-xl rounded-2xl border border-border/80 shadow-2xl shadow-black/20 backdrop-blur-md ${tone === "brand" ? "overflow-hidden bg-card/94" : "bg-card/90"}`}
        >
          {masthead}
          <div className="p-6 sm:p-8">{children}</div>
        </section>
      </div>
    </div>
  );
}

export function StandalonePageHeader({
  eyebrow,
  title,
  description,
}: {
  readonly eyebrow: ReactNode;
  readonly title: ReactNode;
  readonly description: ReactNode;
}) {
  return (
    <>
      <p className="text-[11px] font-semibold tracking-[0.18em] text-muted-foreground uppercase">
        {eyebrow}
      </p>
      <h1 className="mt-3 text-2xl font-semibold tracking-tight sm:text-3xl">{title}</h1>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{description}</p>
    </>
  );
}
