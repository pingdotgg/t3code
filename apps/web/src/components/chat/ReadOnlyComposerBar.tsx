import type { ComponentProps, ReactNode } from "react";

/**
 * What stands where the composer would for a thread that takes no messages. `children` say what
 * the thread is and how it is doing; `actions` sit at the trailing edge.
 */
export function ReadOnlyComposerBar(props: {
  readonly children: ReactNode;
  readonly actions?: ReactNode;
}) {
  // Sized by the composer, not the viewport: a docked side panel narrows the
  // chat column on a wide window, and one row there squeezes out the lead
  // and status, so the status drops to its own line instead.
  return (
    <div className="flex min-h-12 items-center gap-3 rounded-2xl py-2 ps-5 pe-2 text-sm">
      <div className="flex min-w-0 flex-1 items-center gap-3 @max-[560px]/composer-surface:flex-col @max-[560px]/composer-surface:items-start @max-[560px]/composer-surface:gap-0.5">
        {props.children}
      </div>
      {props.actions}
    </div>
  );
}

/** The bar's first line: an icon and what the thread is. */
export function ReadOnlyComposerLead(props: { readonly children: ReactNode }) {
  return <span className="flex min-w-0 max-w-full items-center gap-2">{props.children}</span>;
}

/** The bar's second line, which drops under the lead in a narrow composer. */
export function ReadOnlyComposerStatus(props: Omit<ComponentProps<"span">, "className">) {
  return (
    <span
      className="min-w-0 max-w-full truncate text-muted-foreground tabular-nums @max-[560px]/composer-surface:text-xs"
      {...props}
    />
  );
}
