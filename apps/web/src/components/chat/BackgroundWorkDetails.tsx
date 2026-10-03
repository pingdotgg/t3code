import type { ThreadId } from "@t3tools/contracts";
import {
  formatPendingBackgroundWorkStatus,
  type PendingBackgroundWorkItem,
} from "@t3tools/client-runtime/state/thread-execution";
import { useState } from "react";

import { InlineButton } from "../ui/button";

/**
 * What each piece of background work is and how long it has run, for the
 * composer strip's details popup. The popup mounts on open, so the elapsed
 * time is read then rather than ticking.
 */
export function BackgroundWorkDetails({
  items,
  onOpenThread,
}: {
  readonly items: ReadonlyArray<PendingBackgroundWorkItem>;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const [nowMs] = useState(() => Date.now());
  return (
    <ul className="flex flex-col gap-2.5">
      {items.map((item) => {
        const childThreadId = item.childThreadId;
        return (
          <li key={item.taskId} className="flex min-w-0 flex-col gap-0.5">
            {childThreadId === undefined ? (
              <span className="font-medium">{item.label}</span>
            ) : (
              <InlineButton
                aria-label={`Open subagent ${item.label}`}
                onClick={() => onOpenThread(childThreadId)}
              >
                {item.label}
              </InlineButton>
            )}
            <span className="text-muted-foreground">
              {formatPendingBackgroundWorkStatus(item, nowMs)}
            </span>
            {item.command === undefined ? null : (
              <code className="line-clamp-6 font-mono text-2xs whitespace-pre-wrap">
                {item.command}
              </code>
            )}
          </li>
        );
      })}
    </ul>
  );
}
