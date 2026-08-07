import type { ReactNode } from "react";

interface SessionGridComposerLayoutProps {
  readonly compact: boolean;
  readonly editor: ReactNode;
  readonly controls: ReactNode;
}

// fork: project session grid — a dedicated low-profile arrangement for the
// canonical composer internals. ChatComposer still owns behavior and state;
// this component only changes their spatial hierarchy inside grid panes.
export function SessionGridComposerLayout(props: SessionGridComposerLayoutProps) {
  if (!props.compact) {
    return (
      <>
        {props.editor}
        {props.controls}
      </>
    );
  }

  return (
    <div
      className="grid min-w-0 grid-rows-[auto_auto] overflow-visible"
      data-session-grid-composer-layout="true"
    >
      {props.editor}
      {props.controls}
    </div>
  );
}
