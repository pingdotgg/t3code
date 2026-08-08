import type { ReactNode } from "react";

interface SessionGridComposerLayoutProps {
  readonly compact: boolean;
  readonly editor?: ReactNode;
  readonly controls?: ReactNode;
  readonly children?: ReactNode;
}

// fork: project session grid — a dedicated low-profile arrangement for the
// canonical composer internals. ChatComposer still owns behavior and state;
// this component only changes their spatial hierarchy inside grid panes.
export function SessionGridComposerLayout(props: SessionGridComposerLayoutProps) {
  const content = props.children ?? (
    <>
      {props.editor}
      {props.controls}
    </>
  );

  if (!props.compact) {
    return content;
  }

  return (
    <div
      className="grid min-w-0 grid-rows-[auto_auto] overflow-visible"
      data-session-grid-composer-layout="true"
    >
      {content}
    </div>
  );
}
