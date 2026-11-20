import type { ReactNode } from "react";

import { cn } from "~/lib/utils";

export type StatusDotState = "working" | "waiting" | "done" | "failed";

const STATUS_DOT_CLASS: Record<StatusDotState, string> = {
  working: "bg-info",
  waiting: "bg-muted-foreground/70",
  done: "bg-success",
  failed: "bg-destructive",
};

/** The dot's centre sits 2px in from the icon's top right corner; the ring is 2px around the 6px dot. */
const CUT_OUT_MASK = "radial-gradient(circle at calc(100% - 2px) 2px, transparent 5px, #000 5.5px)";

/**
 * A leading icon with its status as a 6px dot on the top right corner. The dot has a 2px ring that
 * reads as cut out of the icon. Give `ring` the colour of the opaque surface behind the icon. Leave
 * it out on a see-through or changing surface (a sidebar row): the icon is cut away instead, so
 * whatever is behind shows through. The state's name belongs on the card, for the screen reader.
 */
export function StatusDotBadge(props: {
  /** Null shows the icon alone. */
  state: StatusDotState | null;
  ring?: string | undefined;
  className?: string | undefined;
  children: ReactNode;
}) {
  const { state, ring } = props;
  const cutOut = state !== null && ring === undefined;
  return (
    <span className={cn("relative inline-flex shrink-0", props.className)}>
      <span
        className="inline-flex"
        style={cutOut ? { maskImage: CUT_OUT_MASK, WebkitMaskImage: CUT_OUT_MASK } : undefined}
      >
        {props.children}
      </span>
      {state !== null ? (
        <span
          aria-hidden
          data-status-dot={state}
          className={cn(
            "absolute -top-px -right-px size-1.5 rounded-full",
            STATUS_DOT_CLASS[state],
          )}
          style={ring === undefined ? undefined : { boxShadow: `0 0 0 2px ${ring}` }}
        />
      ) : null}
    </span>
  );
}
