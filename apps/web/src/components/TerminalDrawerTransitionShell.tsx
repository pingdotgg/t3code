import { type CSSProperties, type ReactNode } from "react";

import { cn } from "~/lib/utils";

export function TerminalDrawerTransitionShell(props: {
  active: boolean;
  open: boolean;
  height: number;
  resizing: boolean;
  onExitComplete: () => void;
  children: ReactNode;
}) {
  const interactive = props.active && props.open;

  return (
    <div
      className={cn(
        "terminal-drawer-inline-frame",
        props.active ? "terminal-drawer-inline-gap relative shrink-0" : "hidden",
      )}
      style={{ "--terminal-drawer-height": `${props.height}px` } as CSSProperties}
      data-terminal-drawer-active={props.active ? "true" : "false"}
      data-terminal-drawer-open={interactive ? "true" : "false"}
      data-terminal-drawer-resizing={interactive && props.resizing ? "true" : undefined}
      aria-hidden={interactive ? undefined : true}
      inert={interactive ? undefined : true}
      onTransitionEnd={(event) => {
        if (
          !props.active ||
          props.open ||
          event.target !== event.currentTarget ||
          event.propertyName !== "height"
        ) {
          return;
        }
        props.onExitComplete();
      }}
    >
      <div className="terminal-drawer-inline-surface absolute inset-x-0 bottom-0 h-(--terminal-drawer-height)">
        {props.children}
      </div>
    </div>
  );
}
