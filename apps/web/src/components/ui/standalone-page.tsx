import type { ReactNode } from "react";

import { T3Wordmark } from "../T3Wordmark";

export function StandalonePage({ children }: { readonly children: ReactNode }) {
  return (
    // The page owns scrolling because root cannot scroll; safe centering keeps oversized cards top-aligned.
    <div className="flex h-full items-center-safe justify-center overflow-y-auto scrollbar-gutter-both bg-background px-4 py-10 text-foreground sm:px-6">
      <section className="dialog-glass w-full max-w-xl rounded-2xl border p-6">{children}</section>
    </div>
  );
}

export function StandalonePageHeader({
  context,
  title,
  description,
}: {
  readonly context?: ReactNode;
  readonly title: ReactNode;
  readonly description: ReactNode;
}) {
  return (
    <>
      <div className="flex items-baseline justify-between gap-3 text-muted-foreground">
        <span className="flex items-baseline gap-1.5" role="img" aria-label="T3 Code">
          <T3Wordmark className="h-3 w-auto shrink-0 text-foreground" aria-hidden />
          <span className="text-lg font-medium tracking-tight">Code</span>
        </span>
        {context ? <span className="text-sm">{context}</span> : null}
      </div>
      <h1 className="mt-6 text-xl leading-tight font-semibold">{title}</h1>
      <p className="mt-2 text-sm text-muted-foreground">{description}</p>
    </>
  );
}
