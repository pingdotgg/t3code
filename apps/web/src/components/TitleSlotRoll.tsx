import { useState, type ReactNode } from "react";

import { observeVisibleAnimation } from "~/lib/visibleAnimation";

type Phase = "idle" | "parked" | "rolling" | "landing";

export function TitleSlotRoll({
  regenerating,
  from,
  children,
}: {
  regenerating: boolean;
  from?: ReactNode;
  children: ReactNode;
}) {
  const [phase, setPhase] = useState<Phase>(
    regenerating ? (from === undefined ? "parked" : "rolling") : "idle",
  );
  const [outgoing, setOutgoing] = useState(regenerating ? from : undefined);
  if (regenerating && (phase === "idle" || phase === "landing")) setPhase("rolling");
  if (!regenerating && (phase === "rolling" || phase === "parked")) {
    setPhase("landing");
    setOutgoing(undefined);
  }

  if (phase === "idle") return children;

  return (
    <span className="block overflow-hidden">
      <span
        className={
          phase === "parked"
            ? "relative block -translate-y-full"
            : phase === "rolling"
              ? "title-slot-roll-out relative block"
              : "title-slot-roll-in relative block"
        }
        onAnimationEnd={(event) => {
          if (event.target === event.currentTarget && phase === "landing") setPhase("idle");
        }}
      >
        <span className="block truncate">{outgoing ?? children}</span>
        <span
          aria-hidden
          ref={observeVisibleAnimation}
          className="absolute inset-x-0 top-full flex h-full items-center gap-1"
        >
          <span className="title-slot-dot size-1 rounded-full bg-current" />
          <span className="title-slot-dot size-1 rounded-full bg-current" />
          <span className="title-slot-dot size-1 rounded-full bg-current" />
        </span>
        <span aria-hidden className="absolute inset-x-0 top-[200%] block truncate">
          {children}
        </span>
      </span>
    </span>
  );
}
