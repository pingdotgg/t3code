import { memo } from "react";
import { IconPlay as PlayIcon, IconTrash as Trash2Icon } from "symbols-react";

import type { Thread } from "../../types";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import {
  composerPopoverLabelClassName,
  composerPopoverSurfaceClassName,
} from "./composerPopoverStyles";

interface ComposerQueuedTurnsPanelProps {
  turnQueue: Thread["turnQueue"];
  onRemoveQueuedTurn: (messageId: Thread["turnQueue"]["items"][number]["messageId"]) => void;
  onResumeTurnQueue: () => void;
}

function queuedTurnPreview(turn: Thread["turnQueue"]["items"][number]): string {
  const text = turn.text.trim();
  return text.length > 0 ? text : "(Image-only prompt)";
}

export const ComposerQueuedTurnsPanel = memo(function ComposerQueuedTurnsPanel({
  turnQueue,
  onRemoveQueuedTurn,
  onResumeTurnQueue,
}: ComposerQueuedTurnsPanelProps) {
  if (turnQueue.items.length === 0) {
    return null;
  }

  const isPaused = turnQueue.status === "paused";
  const queuedCountLabel = `${turnQueue.items.length} queued`;

  return (
    <div data-composer-queue-panel="true" className={composerPopoverSurfaceClassName}>
      <div className="flex items-center justify-between gap-3 px-3 pt-2 pb-1">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className={cn(
              composerPopoverLabelClassName,
              "px-0 py-0",
              isPaused ? "text-amber-700/85 dark:text-amber-300/90" : "text-muted-foreground/55",
            )}
          >
            {isPaused ? "Paused" : "Queued"}
          </span>
          <span className="text-muted-foreground/70 text-xs">{queuedCountLabel}</span>
        </div>
        {isPaused ? (
          <Button
            size="xs"
            variant="ghost"
            className={cn(
              "rounded-md px-2 text-xs",
              isPaused && "text-amber-700/90 hover:text-amber-800 dark:text-amber-300/90",
            )}
            onClick={onResumeTurnQueue}
          >
            <PlayIcon className="size-3.5" />
            Resume queue
          </Button>
        ) : null}
      </div>

      <div className="max-h-44 overflow-y-auto px-2 pb-2">
        <div className="space-y-0.5">
          {turnQueue.items.map((turn) => {
            const preview = queuedTurnPreview(turn);
            return (
              <div
                key={turn.messageId}
                className="group flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm transition-colors hover:bg-accent/65"
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
    </div>
  );
});
