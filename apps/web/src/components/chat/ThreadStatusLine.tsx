import type { ReactNode } from "react";

import { InlineButton } from "../ui/button";

export function ThreadStatusLine(props: {
  readonly icon: ReactNode;
  readonly label: string;
  readonly actionLabel: string;
  readonly actionDisabled?: boolean;
  readonly onAction: () => void;
  // Set for clock-dependent labels to trigger updates.
  readonly clockMinute?: string;
}) {
  return (
    <div
      data-chat-thread-status-line="true"
      className="mx-auto flex w-full min-w-0 max-w-(--chat-content-max-width) items-center gap-1.5 px-0.5 pb-2 text-muted-foreground text-sm [&_svg]:size-4 [&_svg]:shrink-0"
    >
      <span aria-hidden className="flex w-6 shrink-0 items-center justify-center">
        {props.icon}
      </span>
      <span className="min-w-0 truncate">{props.label}</span>
      <span aria-hidden="true">·</span>
      <InlineButton disabled={props.actionDisabled} onClick={props.onAction}>
        {props.actionLabel}
      </InlineButton>
    </div>
  );
}
