import { memo } from "react";
import { CornerDownRightIcon, ListEndIcon, Trash2Icon } from "lucide-react";
import type { MessageId, OrchestrationQueuedMessage } from "@t3tools/contracts";

import { Button } from "../ui/button";

/**
 * Queued follow-up messages held server-side while a turn runs. Each chip
 * offers Steer (send now, injecting into the active turn) and delete; the
 * queue otherwise auto-drains in order when the turn completes naturally.
 */
export const QueuedMessageChips = memo(function QueuedMessageChips({
  queuedMessages,
  disabled,
  onSteer,
  onRemove,
}: {
  readonly queuedMessages: ReadonlyArray<OrchestrationQueuedMessage>;
  readonly disabled?: boolean;
  readonly onSteer: (messageId: MessageId) => void;
  readonly onRemove: (messageId: MessageId) => void;
}) {
  if (queuedMessages.length === 0) {
    return null;
  }

  return (
    <div className="mx-auto mb-2 flex max-w-3xl flex-col gap-1.5">
      {queuedMessages.map((queuedMessage) => (
        <div
          key={queuedMessage.messageId}
          className="flex items-center gap-2.5 rounded-xl border border-border/60 bg-card/95 py-1.5 pr-1.5 pl-3.5 shadow-sm backdrop-blur"
        >
          <ListEndIcon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
          <span
            className="min-w-0 flex-1 truncate text-sm text-foreground/90"
            title={queuedMessage.text}
          >
            {queuedMessage.text.length > 0
              ? queuedMessage.text
              : `${queuedMessage.attachments.length} attachment(s)`}
          </span>
          <Button
            size="xs"
            variant="ghost"
            disabled={disabled}
            aria-label="Steer: send now, interrupting the current step"
            title="Send now, interrupting the current step"
            onClick={() => onSteer(queuedMessage.messageId)}
          >
            <CornerDownRightIcon className="size-3.5" />
            Steer
          </Button>
          <Button
            size="icon-xs"
            variant="ghost"
            disabled={disabled}
            aria-label="Remove queued message"
            title="Remove queued message"
            onClick={() => onRemove(queuedMessage.messageId)}
          >
            <Trash2Icon className="size-3.5" />
          </Button>
        </div>
      ))}
    </div>
  );
});
