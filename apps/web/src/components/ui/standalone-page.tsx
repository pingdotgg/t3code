import type { ReactNode } from "react";

import { isElectron } from "../../env";

const backdropClassNames = {
  error:
    "absolute inset-x-0 top-0 h-44 bg-[radial-gradient(44rem_16rem_at_top,color-mix(in_srgb,var(--color-red-500)_16%,transparent),transparent)]",
  // The auth card (pairing, CLI connect) sits on the flat pane.
  plain: "",
};

export function StandalonePage({
  tone = "plain",
  size = "page",
  children,
}: {
  readonly tone?: keyof typeof backdropClassNames;
  /** "card" is the compact auth card: 420px wide, 24px inset, 16px between blocks. */
  readonly size?: "page" | "card";
  readonly children: ReactNode;
}) {
  return (
    // The page sits in the shell's inset pane on the window chrome (pen c935Dy), full-bleed
    // below md like the shell. On desktop the chrome row above it holds the traffic lights.
    <div className="flex h-full min-h-0 flex-col overflow-hidden text-foreground">
      {isElectron ? (
        <div className="drag-region h-(--workspace-chrome-row-height) shrink-0" />
      ) : null}
      <div
        className={`relative flex min-h-0 flex-1 items-center-safe justify-center overflow-y-auto scrollbar-gutter-both bg-background surface-grain px-4 py-10 sm:px-6 md:m-(--workspace-pane-inset) md:rounded-pane ${isElectron ? "md:mt-0" : "md:mt-(--workspace-pane-inset-top)"}`}
      >
        {tone === "plain" ? null : (
          <div className="pointer-events-none absolute inset-0 opacity-80" aria-hidden>
            <div className={backdropClassNames[tone]} />
            <div className="absolute inset-0 bg-[linear-gradient(145deg,color-mix(in_srgb,var(--background)_90%,var(--color-black))_0%,var(--background)_55%)]" />
          </div>
        )}

        <section
          className={`relative w-full shrink-0 rounded-[16px] surface-popover ${size === "card" ? "max-w-[420px]" : "max-w-xl"}`}
        >
          <div className={size === "card" ? "flex flex-col gap-4 p-6" : "p-6 sm:p-8"}>
            {children}
          </div>
        </section>
      </div>
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
      {context ? <p className="text-caption text-muted-foreground">{context}</p> : null}
      <h1 className="mt-3 text-title text-strong-foreground">{title}</h1>
      <p className="mt-2 text-body leading-relaxed text-muted-foreground">{description}</p>
    </>
  );
}

/** Round icon tile that leads the auth card. "error" paints the glyph in the danger tone. */
export function StandalonePageIcon({
  tone = "default",
  children,
}: {
  readonly tone?: "default" | "error";
  readonly children: ReactNode;
}) {
  return (
    <div
      aria-hidden
      className={`flex size-10 shrink-0 items-center justify-center rounded-full surface-raised [&_svg]:size-4.5 ${tone === "error" ? "text-error-foreground" : "text-foreground"}`}
    >
      {children}
    </div>
  );
}

/** Title and description for the auth card, without the page eyebrow. */
export function StandaloneCardHeader({
  title,
  description,
}: {
  readonly title: ReactNode;
  readonly description: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <h1 className="text-title text-strong-foreground">{title}</h1>
      <p className="text-body text-muted-foreground">{description}</p>
    </div>
  );
}

/** Dim footnote under the auth card's actions. */
export function StandaloneCardNote({ children }: { readonly children: ReactNode }) {
  return <p className="text-meta text-dim-foreground">{children}</p>;
}
