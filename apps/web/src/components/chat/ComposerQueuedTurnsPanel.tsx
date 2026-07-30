import type { ThreadExtensionState } from "@t3tools/contracts";
import { memo } from "react";
import { PlayIcon, Trash2Icon } from "lucide-react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import {
  composerPopoverLabelClassName,
  composerPopoverSurfaceClassName,
} from "./composerPopoverStyles";

interface ComposerQueuedTurnsPanelProps {
  queue: ThreadExtensionState["queue"];
  onRemoveQueuedTurn: (
    messageId: ThreadExtensionState["queue"]["items"][number]["messageId"],
  ) => void;
  onResumeTurnQueue: () => void;
}

export const ComposerQueuedTurnsPanel = memo(function ComposerQueuedTurnsPanel({
  queue,
  onRemoveQueuedTurn,
  onResumeTurnQueue,
}: ComposerQueuedTurnsPanelProps) {
  if (queue.items.length === 0) return null;

  const paused = queue.status === "paused";
  return (
    <div
      data-composer-queue-panel="true"
      className={cn(composerPopoverSurfaceClassName, "mx-auto w-full")}
    >
      <div className="flex items-center justify-between gap-3 px-3 pt-2 pb-1">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className={cn(
              composerPopoverLabelClassName,
              "px-0 pt-0 pb-0",
              paused ? "text-amber-700/85 dark:text-amber-300/90" : "text-muted-foreground/65",
            )}
          >
            {paused ? "Paused" : "Queued"}
          </span>
          <span className="text-muted-foreground/70 text-xs">
            {queue.items.length} {queue.items.length === 1 ? "turn" : "turns"}
          </span>
        </div>
        {paused ? (
          <Button
            size="xs"
            variant="ghost"
            className="rounded-md px-2 text-amber-700/90 text-xs hover:text-amber-800 dark:text-amber-300/90"
            onClick={onResumeTurnQueue}
          >
            <PlayIcon className="size-3.5" />
            Resume queue
          </Button>
        ) : null}
      </div>
      <div className="max-h-44 overflow-y-auto px-2 pb-2">
        {queue.items.map((turn) => {
          const preview = turn.text.trim() || "(Image-only prompt)";
          return (
            <div
              key={turn.messageId}
              className="group flex items-center gap-2 rounded-lg px-3 py-2 text-[13px] transition-colors duration-(--motion-duration-fast) hover:bg-accent/65 motion-reduce:transition-none"
            >
              <div className="min-w-0 flex-1 truncate text-foreground" title={preview}>
                {preview}
              </div>
              <Button
                size="icon-xs"
                variant="ghost"
                className="shrink-0 rounded-md text-muted-foreground/70 hover:bg-transparent hover:text-foreground"
                aria-label={`Remove queued turn: ${preview}`}
                title="Remove queued turn"
                onClick={() => onRemoveQueuedTurn(turn.messageId)}
              >
                <Trash2Icon className="size-3.5" />
              </Button>
            </div>
          );
        })}
      </div>
    </div>
  );
});
