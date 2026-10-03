import type { OrchestrationQueuedTurn, QueuedTurnId } from "@t3tools/contracts";
import { ArrowDown, ArrowUp, Check, PauseCircle, Pencil, Trash2, X } from "lucide-react";
import { memo } from "react";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";

interface QueuedMessagesPanelProps {
  policyBlocks?: ReadonlyMap<QueuedTurnId, string> | undefined;
  queuedTurns: ReadonlyArray<OrchestrationQueuedTurn>;
  /**
   * Set while crash recovery holds the queue. Nothing drains until the user
   * releases it, so the panel must say so and offer the release.
   */
  queueHeldAt: string | null;
  editingQueuedTurnId: QueuedTurnId | null;
  editingText: string;
  onStartEditingQueuedTurn: (queuedTurn: OrchestrationQueuedTurn) => void;
  onCancelEditingQueuedTurn: () => void;
  onSaveEditingQueuedTurn: () => void;
  onDeleteQueuedTurn: (queuedTurnId: QueuedTurnId) => void;
  onMoveQueuedTurn: (queuedTurnId: QueuedTurnId, direction: -1 | 1) => void;
  onReleaseQueue: () => void;
}

/**
 * A healthy workspace-handoff continuation is T3 plumbing, not a message the
 * user wrote: editing its boilerplate is meaningless and deleting it would
 * strand the thread in a newly bound worktree with nothing left to run. Failed
 * ones stay visible so the stalled handoff is recoverable.
 */
function isHiddenQueuedTurn(queuedTurn: OrchestrationQueuedTurn): boolean {
  return (
    queuedTurn.origin?.kind === "child-nudge" ||
    (queuedTurn.origin?.kind === "workspace-handoff" && queuedTurn.failedAt === null)
  );
}

function queuedTurnLabel(queuedTurn: OrchestrationQueuedTurn): string | null {
  return queuedTurn.origin?.kind === "workspace-handoff"
    ? `Continue in ${queuedTurn.origin.branch}`
    : queuedTurn.message.text;
}

function attachmentLabel(queuedTurn: OrchestrationQueuedTurn): string | null {
  const imageCount = queuedTurn.message.attachments.length;
  if (imageCount === 0) {
    return null;
  }
  return `${imageCount} image${imageCount === 1 ? "" : "s"}`;
}

export const QueuedMessagesPanel = memo(function QueuedMessagesPanel({
  policyBlocks,
  queuedTurns,
  queueHeldAt,
  editingQueuedTurnId,
  editingText,
  onStartEditingQueuedTurn,
  onCancelEditingQueuedTurn,
  onSaveEditingQueuedTurn,
  onDeleteQueuedTurn,
  onMoveQueuedTurn,
  onReleaseQueue,
}: QueuedMessagesPanelProps) {
  const nextEligibleId = queuedTurns.find(
    (turn) => !policyBlocks?.has(turn.id) && turn.origin?.kind !== "child-nudge",
  )?.id;
  const visibleQueuedTurns = queuedTurns.flatMap((queuedTurn, queueIndex) =>
    isHiddenQueuedTurn(queuedTurn) ? [] : [{ queuedTurn, queueIndex }],
  );
  if (visibleQueuedTurns.length === 0) {
    return null;
  }

  return (
    <div className="composer-input-font border-b border-border/55 px-3 py-2">
      <ul className="flex flex-col gap-0.5">
        {visibleQueuedTurns.map(({ queuedTurn, queueIndex }) => {
          const isEditing = editingQueuedTurnId === queuedTurn.id;
          const isFailed = queuedTurn.failedAt !== null;
          const policyBlock = policyBlocks?.get(queuedTurn.id);
          const meta = attachmentLabel(queuedTurn);
          const label = policyBlock
            ? "Pending"
            : queuedTurn.id === nextEligibleId
              ? "Up next"
              : `Queued ${queueIndex + 1}`;
          return (
            <li
              key={queuedTurn.id}
              className={cn(
                "group -mx-1 rounded-lg px-1 py-1 transition-colors",
                isFailed ? "bg-destructive/5" : "hover:bg-muted/35",
              )}
            >
              {isEditing ? (
                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="composer-input-font-secondary font-medium text-muted-foreground">
                      Editing queued message
                    </span>
                    <div className="flex items-center gap-1">
                      <Button
                        type="button"
                        size="xs"
                        variant="ghost"
                        onClick={onCancelEditingQueuedTurn}
                      >
                        <X /> Cancel
                      </Button>
                      <Button
                        type="button"
                        size="xs"
                        disabled={
                          editingText.trim().length === 0 &&
                          queuedTurn.message.attachments.length === 0
                        }
                        onClick={onSaveEditingQueuedTurn}
                      >
                        <Check /> Save
                      </Button>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-2.5">
                  <span
                    className={cn(
                      "composer-input-font-secondary w-16 shrink-0 font-medium text-muted-foreground",
                      isFailed ? "text-destructive" : null,
                    )}
                  >
                    {isFailed ? "Paused" : label}
                  </span>
                  <div className="min-w-0 flex-1 truncate text-foreground/85">
                    {queuedTurnLabel(queuedTurn) || (meta ?? "Queued message")}
                    {meta ? (
                      <span className="composer-input-font-secondary ml-2 text-muted-foreground">
                        {meta}
                      </span>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                    <Button
                      type="button"
                      size="icon-xs"
                      variant="ghost"
                      disabled={queueIndex === 0}
                      aria-label="Move queued message up"
                      title="Move up"
                      onClick={() => onMoveQueuedTurn(queuedTurn.id, -1)}
                    >
                      <ArrowUp />
                    </Button>
                    <Button
                      type="button"
                      size="icon-xs"
                      variant="ghost"
                      disabled={queueIndex === visibleQueuedTurns.length - 1}
                      aria-label="Move queued message down"
                      title="Move down"
                      onClick={() => onMoveQueuedTurn(queuedTurn.id, 1)}
                    >
                      <ArrowDown />
                    </Button>
                    <Button
                      type="button"
                      size="icon-xs"
                      variant="ghost"
                      aria-label="Edit queued message"
                      title="Edit"
                      onClick={() => onStartEditingQueuedTurn(queuedTurn)}
                    >
                      <Pencil />
                    </Button>
                    <Button
                      type="button"
                      size="icon-xs"
                      variant="ghost"
                      aria-label="Delete queued message"
                      title="Delete"
                      onClick={() => onDeleteQueuedTurn(queuedTurn.id)}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                </div>
              )}
              {!isEditing && isFailed && queuedTurn.failureMessage ? (
                <div className="composer-input-font-secondary ml-[4.625rem] mt-0.5 whitespace-pre-wrap break-words text-destructive">
                  {queuedTurn.failureMessage}
                </div>
              ) : null}
              {!isEditing && policyBlock ? (
                <div className="composer-input-font-secondary ml-[4.625rem] mt-0.5 break-words text-muted-foreground">
                  {policyBlock}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      {queueHeldAt !== null ? (
        <div className="mt-1.5 flex items-center gap-2 rounded-md bg-muted/30 px-2 py-1.5">
          <PauseCircle className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="composer-input-font-secondary min-w-0 flex-1 text-muted-foreground">
            Queue held after restart. These messages will not run until you resume them.
          </span>
          <Button type="button" size="xs" onClick={onReleaseQueue}>
            Resume queue
          </Button>
        </div>
      ) : null}
    </div>
  );
});
