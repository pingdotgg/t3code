import type { ReactNode } from "react";

import { isElectron } from "../../env";

export function StandalonePage({
  size = "page",
  children,
}: {
  /** "card" is the compact auth card: 420px wide, 24px inset, 16px between blocks. "bare" draws no card. */
  readonly size?: "page" | "card" | "bare";
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
        {size === "bare" ? (
          children
        ) : (
          <section
            className={`relative w-full shrink-0 rounded-[16px] surface-popover ${size === "card" ? "max-w-[420px]" : "max-w-xl"}`}
          >
            <div className={size === "card" ? "flex flex-col gap-4 p-6" : "p-6 sm:p-8"}>
              {children}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

export function StandalonePageHeader({
  title,
  description,
}: {
  readonly title: ReactNode;
  readonly description: ReactNode;
}) {
  return (
    <>
      <h1 className="text-title text-strong-foreground">{title}</h1>
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
      <h1 className="text-title [font-size:1.125rem] text-strong-foreground">{title}</h1>
      <p className="text-body sm:[font-size:0.8125rem] leading-[1.45] text-muted-foreground">
        {description}
      </p>
    </div>
  );
}

/** Dim footnote under the auth card's actions. */
export function StandaloneCardNote({ children }: { readonly children: ReactNode }) {
  return <p className="text-meta leading-[1.45] text-dim-foreground">{children}</p>;
}
