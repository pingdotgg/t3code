import type * as React from "react";
import { memo, useEffect, useRef, useState } from "react";
import { CornerDownRightIcon, EllipsisIcon, PencilIcon, Trash2Icon } from "lucide-react";
import { type QueuedFollowUp } from "../../types";
import { describeQueuedFollowUp } from "../ChatView.logic";
import { Button } from "../ui/button";

function resolveDropPosition(
  event: Pick<React.DragEvent<HTMLDivElement>, "clientY" | "currentTarget">,
): "before" | "after" {
  const bounds = event.currentTarget.getBoundingClientRect();
  return event.clientY <= bounds.top + bounds.height / 2 ? "before" : "after";
}

function resolveTargetIndex(
  currentIndex: number,
  hoveredIndex: number,
  position: "before" | "after",
): number {
  if (position === "before") {
    return currentIndex < hoveredIndex ? hoveredIndex - 1 : hoveredIndex;
  }
  return currentIndex < hoveredIndex ? hoveredIndex : hoveredIndex + 1;
}

function QueuedFollowUpSummaryIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="size-[19px]"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M6.5 6.5v7a2 2 0 0 0 2 2H16" />
      <path d="M10.5 8.5H15" />
      <path d="M10.5 12.5H15" />
      <path d="M15.5 17.5H20" />
      <path d="m18 15 2.5 2.5L18 20" />
    </svg>
  );
}

function DragGripDots() {
  return (
    <span
      aria-hidden="true"
      className="grid grid-cols-2 gap-0.5 text-muted-foreground/58 opacity-0 transition-all duration-150 group-hover/drag:translate-x-0 group-hover/drag:opacity-100 group-focus-visible/drag:translate-x-0 group-focus-visible/drag:opacity-100"
    >
      {Array.from({ length: 6 }, (_, index) => (
        <span key={index} className="size-0.75 rounded-full bg-current" />
      ))}
    </span>
  );
}

export const ComposerQueuedFollowUpsPanel = memo(function ComposerQueuedFollowUpsPanel({
  queuedFollowUps,
  onDelete,
  onEdit,
  onReorder,
  onSteer,
}: {
  queuedFollowUps: ReadonlyArray<QueuedFollowUp>;
  onDelete: (followUpId: string) => void;
  onEdit: (followUpId: string) => void;
  onReorder: (followUpId: string, targetIndex: number) => void;
  onSteer: (followUpId: string) => void;
}) {
  const [actionsOpenFollowUpId, setActionsOpenFollowUpId] = useState<string | null>(null);
  const [draggedFollowUpId, setDraggedFollowUpId] = useState<string | null>(null);
  const [dropIndicator, setDropIndicator] = useState<{
    followUpId: string;
    position: "before" | "after";
  } | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      if (!panelRef.current?.contains(event.target as Node)) {
        setActionsOpenFollowUpId(null);
      }
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
    };
  }, []);

  if (queuedFollowUps.length === 0) {
    return null;
  }

  const draggedIndex =
    draggedFollowUpId === null
      ? -1
      : queuedFollowUps.findIndex((followUp) => followUp.id === draggedFollowUpId);

  return (
    <div
      ref={panelRef}
      className="relative z-0 mx-auto mb-[-28px] w-[calc(100%-3.25rem)] overflow-hidden rounded-[24px] border border-border/60 bg-card/95 shadow-none sm:w-[calc(100%-4.5rem)]"
      data-testid="queued-follow-ups-panel"
    >
      <div className="pointer-events-none absolute right-5 top-1 text-[11px] text-muted-foreground/68">
        {queuedFollowUps.length} queued
      </div>
      <div className="divide-y divide-border/35 pb-8 pt-4">
        {queuedFollowUps.map((followUp, index) => (
          <div
            key={followUp.id}
            className="group relative flex min-h-8.5 items-center gap-0.75 px-0.75 py-0.5"
            data-testid={`queued-follow-up-${followUp.id}`}
            onDragOver={(event) => {
              if (draggedIndex < 0) {
                return;
              }
              event.preventDefault();
              const position = resolveDropPosition(event);
              setDropIndicator({ followUpId: followUp.id, position });
            }}
            onDrop={(event) => {
              if (draggedIndex < 0 || draggedFollowUpId === null) {
                return;
              }
              event.preventDefault();
              const position = resolveDropPosition(event);
              const targetIndex = resolveTargetIndex(draggedIndex, index, position);
              onReorder(draggedFollowUpId, targetIndex);
              setDraggedFollowUpId(null);
              setDropIndicator(null);
            }}
          >
            {dropIndicator?.followUpId === followUp.id ? (
              <span
                aria-hidden="true"
                className={`absolute left-1 right-1 h-px bg-foreground/30 ${
                  dropIndicator.position === "before" ? "top-0" : "bottom-0"
                }`}
              />
            ) : null}
            <button
              type="button"
              draggable
              className="group/drag inline-flex h-5 w-4 shrink-0 cursor-grab items-center justify-center overflow-hidden rounded-md text-muted-foreground/58 transition-[width,color,background-color] duration-150 hover:w-7 hover:bg-accent/40 hover:text-foreground focus-visible:w-7 focus-visible:bg-accent/40 focus-visible:text-foreground active:cursor-grabbing"
              aria-label={`Drag to reorder queued follow-up ${describeQueuedFollowUp(followUp)}`}
              title="Drag to reorder"
              data-testid={`queued-follow-up-drag-handle-${followUp.id}`}
              onDragStart={(event) => {
                setDraggedFollowUpId(followUp.id);
                setDropIndicator({ followUpId: followUp.id, position: "before" });
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/plain", followUp.id);
              }}
              onDragEnd={() => {
                setDraggedFollowUpId(null);
                setDropIndicator(null);
              }}
            >
              <span aria-hidden="true" className="inline-flex items-center gap-0.5 px-0.5">
                <DragGripDots />
                <QueuedFollowUpSummaryIcon />
              </span>
            </button>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm text-foreground/76">
                {describeQueuedFollowUp(followUp)}
              </p>
              {followUp.lastSendError ? (
                <p className="mt-1 text-xs text-destructive">{followUp.lastSendError}</p>
              ) : null}
            </div>
            <div className="relative flex shrink-0 flex-wrap items-center justify-end gap-0.5">
              <Button
                size="xs"
                variant="secondary"
                className="h-7 rounded-full px-2"
                onClick={() => onSteer(followUp.id)}
              >
                <CornerDownRightIcon className="size-3.5" />
                Steer
              </Button>
              <Button
                size="icon-xs"
                variant="ghost"
                className="rounded-full text-muted-foreground"
                aria-label={`Delete queued follow-up ${describeQueuedFollowUp(followUp)}`}
                onClick={() => onDelete(followUp.id)}
              >
                <Trash2Icon className="size-4" />
              </Button>
              <Button
                size="icon-xs"
                variant="ghost"
                className="rounded-full text-muted-foreground"
                aria-label={`More queued follow-up actions ${describeQueuedFollowUp(followUp)}`}
                onClick={() =>
                  setActionsOpenFollowUpId((current) =>
                    current === followUp.id ? null : followUp.id,
                  )
                }
              >
                <EllipsisIcon className="size-4" />
              </Button>
              {actionsOpenFollowUpId === followUp.id ? (
                <div className="absolute right-0 top-full z-20 mt-2 min-w-32 rounded-xl border border-border/70 bg-popover p-1 shadow-lg">
                  <button
                    type="button"
                    className="flex min-h-8 w-full items-center gap-2 rounded-lg px-2 py-1 text-left text-sm text-foreground outline-none transition-colors hover:bg-accent"
                    aria-label={`Edit queued follow-up ${describeQueuedFollowUp(followUp)}`}
                    onClick={() => {
                      onEdit(followUp.id);
                      setActionsOpenFollowUpId(null);
                    }}
                  >
                    <PencilIcon className="size-4" />
                    Edit
                  </button>
                </div>
              ) : null}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
});
