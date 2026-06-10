import type { OrchestrationQueuedTurn, QueuedTurnId } from "@t3tools/contracts";
import { Check, Pencil, Trash2, X } from "lucide-react";
import { memo, useState } from "react";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";

interface QueuedMessagesPanelProps {
  queuedTurns: ReadonlyArray<OrchestrationQueuedTurn>;
  onUpdateQueuedTurn: (queuedTurnId: QueuedTurnId, text: string) => void;
  onDeleteQueuedTurn: (queuedTurnId: QueuedTurnId) => void;
}

function attachmentLabel(queuedTurn: OrchestrationQueuedTurn): string | null {
  const imageCount = queuedTurn.message.attachments.length;
  if (imageCount === 0) {
    return null;
  }
  return `${imageCount} image${imageCount === 1 ? "" : "s"}`;
}

export const QueuedMessagesPanel = memo(function QueuedMessagesPanel({
  queuedTurns,
  onUpdateQueuedTurn,
  onDeleteQueuedTurn,
}: QueuedMessagesPanelProps) {
  const [editingId, setEditingId] = useState<QueuedTurnId | null>(null);
  const [editingText, setEditingText] = useState("");

  if (queuedTurns.length === 0) {
    return null;
  }

  const stopEditing = () => {
    setEditingId(null);
    setEditingText("");
  };

  const commitEdit = (queuedTurn: OrchestrationQueuedTurn) => {
    const trimmed = editingText.trim();
    if (trimmed.length === 0 && queuedTurn.message.attachments.length === 0) {
      return;
    }
    onUpdateQueuedTurn(queuedTurn.id, editingText);
    stopEditing();
  };

  return (
    <div className="composer-input-font border-b border-border/55 px-3 py-2">
      <ul className="flex flex-col gap-0.5">
        {queuedTurns.map((queuedTurn, index) => {
          const isEditing = editingId === queuedTurn.id;
          const isPaused = queuedTurn.failedAt !== null;
          const meta = attachmentLabel(queuedTurn);
          const label = index === 0 ? "Up next" : `Queued ${index + 1}`;
          return (
            <li
              key={queuedTurn.id}
              className={cn(
                "group -mx-1 rounded-lg px-1 py-1 transition-colors",
                isPaused ? "bg-destructive/5" : "hover:bg-muted/35",
              )}
            >
              {isEditing ? (
                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="composer-input-font-secondary font-medium text-muted-foreground">
                      Editing queued message
                    </span>
                    <div className="flex items-center gap-1">
                      <Button type="button" size="xs" variant="ghost" onClick={stopEditing}>
                        <X /> Cancel
                      </Button>
                      <Button
                        type="button"
                        size="xs"
                        disabled={
                          editingText.trim().length === 0 &&
                          queuedTurn.message.attachments.length === 0
                        }
                        onClick={() => commitEdit(queuedTurn)}
                      >
                        <Check /> Save
                      </Button>
                    </div>
                  </div>
                  <textarea
                    autoFocus
                    value={editingText}
                    onChange={(event) => setEditingText(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") {
                        event.preventDefault();
                        stopEditing();
                      } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                        event.preventDefault();
                        commitEdit(queuedTurn);
                      }
                    }}
                    className="min-h-10 w-full resize-y rounded-md bg-muted/45 px-2 py-1.5 text-foreground outline-none ring-ring/30 transition-shadow placeholder:text-muted-foreground/60 focus-visible:ring-2"
                  />
                </div>
              ) : (
                <div className="flex items-center gap-2.5">
                  <span
                    className={cn(
                      "composer-input-font-secondary w-16 shrink-0 font-medium text-muted-foreground",
                      isPaused ? "text-destructive" : null,
                    )}
                  >
                    {isPaused ? "Paused" : label}
                  </span>
                  <div className="min-w-0 flex-1 truncate text-foreground/85">
                    {queuedTurn.message.text || (meta ?? "Queued message")}
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
                      aria-label="Edit queued message"
                      title="Edit"
                      onClick={() => {
                        setEditingId(queuedTurn.id);
                        setEditingText(queuedTurn.message.text);
                      }}
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
              {!isEditing && isPaused && queuedTurn.failureMessage ? (
                <div className="composer-input-font-secondary ml-[4.625rem] mt-0.5 truncate text-destructive">
                  {queuedTurn.failureMessage}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
});
