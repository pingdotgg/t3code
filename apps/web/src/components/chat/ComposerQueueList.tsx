import { memo } from "react";
import { ImageIcon, SendHorizontalIcon, XIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import type { QueuedMessage } from "~/messageQueueStore";
import { Button } from "../ui/button";
import { formatQueuedMessagePreview } from "./messageQueue.logic";

interface ComposerQueueListProps {
  readonly messages: ReadonlyArray<QueuedMessage>;
  /** Blocks both actions while a send is already on its way out. */
  readonly disabled?: boolean;
  readonly onSendNow: (messageId: string) => void;
  readonly onDiscard: (messageId: string) => void;
  readonly className?: string;
}

/**
 * The prompts waiting for the agent, oldest first. They are not part of the
 * conversation yet — each row can still be sent by hand (which steers the
 * running turn) or dropped before it ever reaches the thread.
 */
export const ComposerQueueList = memo(function ComposerQueueList({
  messages,
  disabled = false,
  onSendNow,
  onDiscard,
  className,
}: ComposerQueueListProps) {
  if (messages.length === 0) {
    return null;
  }

  return (
    <div
      data-composer-queue-list="true"
      className={cn("mx-auto mb-2 flex max-w-3xl flex-col gap-1", className)}
    >
      <div className="px-2 text-[11px] font-medium text-muted-foreground">
        {messages.length === 1 ? "1 message queued" : `${messages.length} messages queued`}
      </div>
      {messages.map((message, index) => (
        <div
          key={message.id}
          className="flex items-center gap-2 rounded-[18px] border border-border/60 bg-background/96 px-3 py-1.5 shadow-[0_6px_18px_rgba(0,0,0,0.06)]"
        >
          <span className="w-4 shrink-0 text-[11px] tabular-nums text-muted-foreground">
            {index + 1}
          </span>
          <span className="min-w-0 flex-1 truncate text-xs" title={message.text}>
            {formatQueuedMessagePreview({
              text: message.text,
              imageCount: message.images.length,
            })}
          </span>
          {message.images.length > 0 ? (
            <span
              className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground"
              aria-label={
                message.images.length === 1
                  ? "1 image attached"
                  : `${message.images.length} images attached`
              }
            >
              <ImageIcon className="size-3" aria-hidden="true" />
              {message.images.length}
            </span>
          ) : null}
          <div className="flex shrink-0 items-center gap-0.5">
            <Button
              size="icon-xs"
              variant="ghost"
              disabled={disabled}
              aria-label="Send this message now"
              onClick={() => onSendNow(message.id)}
            >
              <SendHorizontalIcon className="size-3.5" />
            </Button>
            <Button
              size="icon-xs"
              variant="ghost"
              disabled={disabled}
              aria-label="Remove this message from the queue"
              onClick={() => onDiscard(message.id)}
            >
              <XIcon className="size-3.5" />
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
});
