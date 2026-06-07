import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { restrictToParentElement, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  arrayMove,
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { IconGripVertical, IconPencil, IconTrash, IconCornerDownRight } from "@tabler/icons-react";
import type { TurnId } from "@t3tools/contracts";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { TurnDiffSummary } from "../../types";
import { cn } from "~/lib/utils";

export type QueuedMessagePanelItem = {
  readonly id: string;
  readonly text: string;
};

export type QueuedMessageDiffSummary = {
  readonly fileCount: number;
  readonly additions: number;
  readonly deletions: number;
};

function summarizeTurnDiff(summary: TurnDiffSummary | null): {
  readonly fileCount: number;
  readonly additions: number;
  readonly deletions: number;
} {
  if (!summary) {
    return { fileCount: 0, additions: 0, deletions: 0 };
  }
  return summary.files.reduce(
    (acc, file) => ({
      fileCount: acc.fileCount + 1,
      additions: acc.additions + (file.additions ?? 0),
      deletions: acc.deletions + (file.deletions ?? 0),
    }),
    { fileCount: 0, additions: 0, deletions: 0 },
  );
}

function QueuedMessageRow(props: {
  item: QueuedMessagePanelItem;
  onDelete: (id: string) => void;
  onEdit: (id: string) => void;
  onSteer: (id: string) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: props.item.id,
  });

  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Translate.toString(transform),
        transition,
      }}
      className={cn(
        "flex min-h-8 items-center gap-1.5 px-3 text-xs text-muted-foreground",
        isDragging && "relative z-10 rounded-md bg-card opacity-90 shadow-lg/10",
      )}
    >
      <button
        type="button"
        aria-label="Reorder queued message"
        className="-ml-1 inline-flex size-6 shrink-0 cursor-grab items-center justify-center rounded-md text-muted-foreground/70 outline-none transition-colors hover:bg-accent hover:text-foreground active:cursor-grabbing"
        {...attributes}
        {...listeners}
      >
        <IconGripVertical className="size-3.5" />
      </button>
      <IconCornerDownRight className="size-3.5 shrink-0 text-muted-foreground/70" />
      <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
        {props.item.text}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-6 gap-1 px-1.5 text-xs text-muted-foreground hover:text-foreground"
        onClick={() => props.onSteer(props.item.id)}
      >
        <IconCornerDownRight className="size-3.5" />
        Steer
      </Button>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="text-muted-foreground hover:text-foreground"
              onClick={() => props.onEdit(props.item.id)}
              aria-label="Edit queued message"
            />
          }
        >
          <IconPencil />
        </TooltipTrigger>
        <TooltipPopup side="top">Edit queued message</TooltipPopup>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="text-muted-foreground hover:text-foreground"
              onClick={() => props.onDelete(props.item.id)}
              aria-label="Delete queued message"
            />
          }
        >
          <IconTrash />
        </TooltipTrigger>
        <TooltipPopup side="top">Delete queued message</TooltipPopup>
      </Tooltip>
    </div>
  );
}

export function QueuedMessagesPanel(props: {
  activeTurnId: TurnId | null;
  activeTurnDiffSummary: TurnDiffSummary | null;
  activeChangeSummary: QueuedMessageDiffSummary | null;
  items: readonly QueuedMessagePanelItem[];
  onDelete: (id: string) => void;
  onEdit: (id: string) => void;
  onReviewDiff: (turnId: TurnId) => void;
  onReorder: (ids: readonly string[]) => void;
  onSteer: (id: string) => void;
}) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const diffSummary = props.activeChangeSummary ?? summarizeTurnDiff(props.activeTurnDiffSummary);

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) {
      return;
    }
    const ids = props.items.map((item) => item.id);
    const oldIndex = ids.indexOf(String(active.id));
    const newIndex = ids.indexOf(String(over.id));
    if (oldIndex < 0 || newIndex < 0) {
      return;
    }
    props.onReorder(arrayMove(ids, oldIndex, newIndex));
  };

  if (props.items.length === 0 && diffSummary.fileCount === 0) {
    return null;
  }

  return (
    <div
      className="mx-auto -mb-px w-[calc(100%-2.5rem)] min-w-0 overflow-hidden rounded-b-none rounded-t-[20px] border border-border/45 bg-card text-card-foreground"
      data-testid="queued-messages-panel"
    >
      <div
        className={cn(
          "flex min-h-9 items-center gap-2 px-3 text-xs",
          props.items.length > 0 ? "border-b border-border/35" : null,
        )}
      >
        <span className="min-w-0 flex-1 truncate text-muted-foreground">
          {diffSummary.fileCount} {diffSummary.fileCount === 1 ? "file" : "files"} changed{" "}
          <span className="text-emerald-400">+{diffSummary.additions}</span>{" "}
          <span className="text-red-400">-{diffSummary.deletions}</span>
        </span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs text-foreground"
          disabled={!props.activeTurnId}
          onClick={() => {
            if (props.activeTurnId) {
              props.onReviewDiff(props.activeTurnId);
            }
          }}
        >
          Review
        </Button>
      </div>
      {props.items.length > 0 ? (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          modifiers={[restrictToVerticalAxis, restrictToParentElement]}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={props.items.map((item) => item.id)}
            strategy={verticalListSortingStrategy}
          >
            <div className="divide-y divide-border/45">
              {props.items.map((item) => (
                <QueuedMessageRow
                  key={item.id}
                  item={item}
                  onDelete={props.onDelete}
                  onEdit={props.onEdit}
                  onSteer={props.onSteer}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      ) : null}
    </div>
  );
}
