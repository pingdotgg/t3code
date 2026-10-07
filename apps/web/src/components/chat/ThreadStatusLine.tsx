import type { ReactNode } from "react";

import { InlineButton } from "../ui/button";

/**
 * One quiet line after the last message for thread state that does not change
 * what Enter does: settled, snoozed, or just woke. Sending a message clears each of
 * them, so the action is only the explicit way out.
 */
export function ThreadStatusLine(props: {
  readonly icon: ReactNode;
  readonly label: string;
  readonly actionLabel: string;
  readonly actionDisabled?: boolean;
  readonly onAction: () => void;
}) {
  return (
    <div
      data-chat-thread-status-line="true"
      className="mx-auto flex w-full min-w-0 max-w-(--chat-content-max-width) items-center gap-1.5 px-4 pb-2 text-muted-foreground text-xs [&_svg]:size-3.5 [&_svg]:shrink-0"
    >
      {props.icon}
      <span className="min-w-0 truncate">{props.label}</span>
      <span aria-hidden="true">·</span>
      <InlineButton tone="muted" disabled={props.actionDisabled} onClick={props.onAction}>
        {props.actionLabel}
      </InlineButton>
    </div>
  );
}
