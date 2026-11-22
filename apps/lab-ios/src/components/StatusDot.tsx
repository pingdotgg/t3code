import type { ReactNode } from "react";
import "./StatusDot.css";

export type DotState = "working" | "waiting" | "done" | "failed" | "limited";

/** A 6pt dot with a 2pt ring in the surface colour behind it (apps/mobile StatusBadgeDot). */
export function StatusDot(props: { readonly state: DotState; readonly ring: string }) {
  return (
    <span className="m-dot" style={{ background: props.ring }}>
      <span className="m-dot-core" data-state={props.state} />
    </span>
  );
}

/** An icon with the status dot on its top-right corner; the ring takes the surface colour. */
export function WithStatusDot(props: {
  readonly state: DotState;
  readonly ring: string;
  readonly children: ReactNode;
}) {
  return (
    <span className="m-dot-host">
      {props.children}
      <span className="m-dot-corner">
        <StatusDot state={props.state} ring={props.ring} />
      </span>
    </span>
  );
}
