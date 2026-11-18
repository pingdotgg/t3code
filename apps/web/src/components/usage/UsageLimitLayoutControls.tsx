import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  pointerWithin,
  type CollisionDetection,
  type KeyboardCoordinateGetter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { SortableContext, type useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { useGT } from "gt-react";
import { GripVerticalIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "../../lib/utils";
import { Button } from "../ui/button";

const limitCollisionDetection: CollisionDetection = (args) => {
  const collisions = pointerWithin(args);
  return collisions.length > 0 ? collisions : closestCenter(args);
};

export function UsageLimitSortableList({
  items,
  onReorder,
  children,
}: {
  readonly items: string[];
  readonly onReorder: (active: string, over: string) => void;
  readonly children: ReactNode;
}) {
  const gt = useGT();
  const position = (id: string | number) => items.indexOf(String(id)) + 1;
  const keyboardCoordinates: KeyboardCoordinateGetter = (
    event,
    { context, currentCoordinates },
  ) => {
    if (event.code !== "ArrowUp" && event.code !== "ArrowDown") return;
    event.preventDefault();
    const index = items.indexOf(String(context.over?.id ?? context.active?.id));
    const target = items[index + (event.code === "ArrowDown" ? 1 : -1)];
    const rect = target === undefined ? undefined : context.droppableRects.get(target);
    if (!rect || !context.collisionRect) return;
    return {
      ...currentCoordinates,
      y:
        currentCoordinates.y +
        rect.top +
        rect.height / 2 -
        (context.collisionRect.top + context.collisionRect.height / 2),
    };
  };
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: keyboardCoordinates }),
  );
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={limitCollisionDetection}
      modifiers={[restrictToVerticalAxis]}
      accessibility={{
        screenReaderInstructions: {
          draggable: gt(
            "Press Space to pick up. Use the arrow keys to move, Space to drop, and Escape to cancel.",
          ),
        },
        announcements: {
          onDragStart: ({ active }) =>
            gt("Picked up item at position {position}.", { position: position(active.id) }),
          onDragOver: ({ over }) =>
            over ? gt("Moved to position {position}.", { position: position(over.id) }) : undefined,
          onDragEnd: ({ over }) =>
            over
              ? gt("Dropped at position {position}.", { position: position(over.id) })
              : gt("Reorder canceled."),
          onDragCancel: () => gt("Reorder canceled."),
        },
      }}
      onDragEnd={({ active, over }) => {
        if (over && active.id !== over.id) onReorder(String(active.id), String(over.id));
      }}
    >
      <SortableContext items={items} strategy={verticalListSortingStrategy}>
        {children}
      </SortableContext>
    </DndContext>
  );
}

export function UsageLimitLayoutControls({
  label,
  hidden,
  attributes,
  listeners,
  handleRef,
  isDragging,
  pinned = false,
  onToggleVisibility,
  children,
}: {
  readonly label: string;
  readonly hidden: boolean;
  readonly attributes: ReturnType<typeof useSortable>["attributes"];
  readonly listeners: ReturnType<typeof useSortable>["listeners"];
  readonly handleRef: ReturnType<typeof useSortable>["setActivatorNodeRef"];
  readonly isDragging: boolean;
  readonly pinned?: boolean;
  readonly onToggleVisibility: () => void;
  readonly children?: ReactNode;
}) {
  const gt = useGT();
  const visibilityLabel = hidden ? gt("Show {label}", { label }) : gt("Hide {label}", { label });
  return (
    <div
      className={cn(
        "flex shrink-0 items-center gap-0.5 rounded-full border border-border/60 bg-background p-0.5 shadow-xs",
        isDragging || hidden || pinned
          ? "pointer-events-auto opacity-100"
          : "pointer-events-none opacity-0 group-has-[:focus-visible]/limit-row:pointer-events-auto group-has-[:focus-visible]/limit-row:opacity-100 group-hover/limit-row:pointer-events-auto group-hover/limit-row:opacity-100 pointer-coarse:pointer-events-auto pointer-coarse:opacity-100 [@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100",
      )}
    >
      <button
        type="button"
        ref={handleRef}
        {...attributes}
        {...listeners}
        aria-label={gt("Reorder {label}", { label })}
        className="flex size-6 shrink-0 cursor-grab touch-none items-center justify-center rounded-full text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring active:cursor-grabbing"
      >
        <GripVerticalIcon className="size-4" aria-hidden />
      </button>
      <Button
        variant="ghost-muted"
        size="xs"
        aria-label={visibilityLabel}
        title={visibilityLabel}
        onClick={onToggleVisibility}
      >
        {hidden ? gt("Show") : gt("Hide")}
      </Button>
      {children}
    </div>
  );
}
