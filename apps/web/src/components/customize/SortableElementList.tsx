import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { restrictToParentElement, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVerticalIcon, LockIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "~/lib/utils";
import { Switch } from "../ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export interface SortableElement {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly hidden: boolean;
  /** Always shown; the switch is replaced by a lock. */
  readonly required?: boolean;
  /** Can't be reordered, e.g. an element with a fixed place in the surface. */
  readonly fixed?: boolean;
}

function ElementRow({
  element,
  sortable,
  onHiddenChange,
}: {
  element: SortableElement;
  sortable: ReturnType<typeof useSortable> | null;
  onHiddenChange: (hidden: boolean) => void;
}) {
  return (
    <li
      ref={sortable?.setNodeRef}
      style={
        sortable
          ? {
              transform: CSS.Translate.toString(sortable.transform),
              transition: sortable.transition,
            }
          : undefined
      }
      className={cn(
        "flex h-9 items-center gap-1.5 rounded-lg border border-transparent ps-1 pe-2 transition-[background-color,border-color,box-shadow]",
        sortable?.isDragging
          ? "relative z-10 border-border bg-popover shadow-md/10"
          : "hover:bg-accent/40",
      )}
    >
      {sortable ? (
        <button
          type="button"
          aria-label={`Move ${element.label}`}
          className="flex size-6 shrink-0 cursor-grab touch-none items-center justify-center rounded-md text-muted-foreground/70 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing"
          {...sortable.attributes}
          {...sortable.listeners}
        >
          <GripVerticalIcon className="size-3.5" />
        </button>
      ) : (
        <span aria-hidden className="size-6 shrink-0" />
      )}
      <span
        className={cn(
          "min-w-0 flex-1 truncate text-sm transition-colors",
          element.hidden ? "text-muted-foreground line-through decoration-muted-foreground/40" : "",
        )}
      >
        {element.label}
      </span>
      {element.required ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                role="img"
                aria-label={`${element.label} is always shown`}
                className="flex size-6 items-center justify-center text-muted-foreground/60"
              />
            }
          >
            <LockIcon className="size-3.5" />
          </TooltipTrigger>
          <TooltipPopup side="top">{element.description ?? "Always shown"}</TooltipPopup>
        </Tooltip>
      ) : (
        <Switch
          size="sm"
          aria-label={`Show ${element.label}`}
          checked={!element.hidden}
          onCheckedChange={(checked) => onHiddenChange(!checked)}
        />
      )}
    </li>
  );
}

function SortableElementRow(props: {
  element: SortableElement;
  onHiddenChange: (hidden: boolean) => void;
}) {
  const sortable = useSortable({ id: props.element.id });
  return <ElementRow {...props} sortable={sortable} />;
}

/**
 * An element list: drag handles reorder, switches show and hide. Fixed rows
 * render in place without a handle so the list still mirrors the surface.
 */
export function SortableElementList({
  label,
  elements,
  onMove,
  onHiddenChange,
  footer,
}: {
  label: string;
  elements: ReadonlyArray<SortableElement>;
  onMove: (activeId: string, overId: string) => void;
  onHiddenChange: (id: string, hidden: boolean) => void;
  footer?: ReactNode;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const sortableIds = elements.filter((element) => !element.fixed).map((element) => element.id);
  const handleDragEnd = (event: DragEndEvent) => {
    if (!event.over || event.active.id === event.over.id) return;
    onMove(String(event.active.id), String(event.over.id));
  };
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      modifiers={[restrictToVerticalAxis, restrictToParentElement]}
      onDragEnd={handleDragEnd}
      accessibility={{
        screenReaderInstructions: {
          draggable:
            "To move an element, press space or enter, use the arrow keys, then press space or enter again to drop it.",
        },
      }}
    >
      <SortableContext items={sortableIds} strategy={verticalListSortingStrategy}>
        <ul aria-label={label} className="relative -mx-1 flex flex-col gap-0.5">
          {elements.map((element) =>
            element.fixed ? (
              <ElementRow
                key={element.id}
                element={element}
                sortable={null}
                onHiddenChange={(hidden) => onHiddenChange(element.id, hidden)}
              />
            ) : (
              <SortableElementRow
                key={element.id}
                element={element}
                onHiddenChange={(hidden) => onHiddenChange(element.id, hidden)}
              />
            ),
          )}
          {footer}
        </ul>
      </SortableContext>
    </DndContext>
  );
}
