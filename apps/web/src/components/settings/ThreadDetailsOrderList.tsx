import {
  DndContext,
  type DragEndEvent,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { restrictToParentElement, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { T, useGT, useMessages } from "gt-react";
import { ArrowDownIcon, ArrowUpIcon, GripVerticalIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { updateClientSettings } from "../../hooks/useSettings";
import {
  moveThreadDetailsSection,
  THREAD_DETAILS_SECTIONS,
  type ThreadDetailsSectionId,
  type ThreadDetailsVisibility,
} from "../chat/threadDetailsItems";
import { Button } from "../ui/button";

/** The thread details card's sections, top first. Keyboard users reorder with the step buttons. */
export function ThreadDetailsOrderList(props: {
  readonly order: ReadonlyArray<ThreadDetailsSectionId>;
  readonly visibility: ThreadDetailsVisibility;
}) {
  const gt = useGT();
  const m = useMessages();
  const { order } = props;
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const move = (id: ThreadDetailsSectionId, steps: number) =>
    updateClientSettings({ threadDetailsOrder: moveThreadDetailsSection(order, id, steps) });
  const handleDragEnd = (event: DragEndEvent) => {
    if (event.over === null || event.active.id === event.over.id) return;
    const id = event.active.id as ThreadDetailsSectionId;
    move(id, order.indexOf(event.over.id as ThreadDetailsSectionId) - order.indexOf(id));
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      modifiers={[restrictToVerticalAxis, restrictToParentElement]}
      onDragEnd={handleDragEnd}
    >
      <SortableContext items={[...order]} strategy={verticalListSortingStrategy}>
        <ol
          aria-label={gt("Thread details sections, top first")}
          className="divide-y divide-border/60 rounded-lg border border-border/60"
        >
          {order.map((id, index) => {
            const section = THREAD_DETAILS_SECTIONS.find((candidate) => candidate.id === id)!;
            return (
              <SectionRow
                key={id}
                id={id}
                name={m(section.label)}
                hidden={section.items.every((item) => !props.visibility[item])}
                position={index + 1}
                count={order.length}
                onMove={(steps) => move(id, steps)}
              />
            );
          })}
        </ol>
      </SortableContext>
    </DndContext>
  );
}

function SectionRow(props: {
  readonly id: ThreadDetailsSectionId;
  readonly name: string;
  readonly hidden: boolean;
  readonly position: number;
  readonly count: number;
  readonly onMove: (steps: number) => void;
}) {
  const gt = useGT();
  const { name } = props;
  const { listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } =
    useSortable({ id: props.id });
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(
        "flex items-center gap-2 py-1 ps-1.5 pe-1.5",
        isDragging && "relative z-10 rounded-lg bg-background shadow-md",
      )}
    >
      <span
        ref={setActivatorNodeRef}
        {...listeners}
        aria-hidden
        className="flex size-6 shrink-0 cursor-grab touch-none items-center justify-center rounded text-muted-foreground/70 hover:text-foreground active:cursor-grabbing"
      >
        <GripVerticalIcon className="size-3.5" />
      </span>
      <span
        className={cn(
          "min-w-0 flex-1 text-sm leading-5 break-words",
          props.hidden && "text-muted-foreground",
        )}
      >
        {name}
      </span>
      {props.hidden ? (
        <span className="shrink-0 text-2xs text-muted-foreground">
          <T context="thread details section that is turned off">Off</T>
        </span>
      ) : null}
      <span className="flex shrink-0 items-center gap-0.5">
        <Button
          type="button"
          size="icon-xs"
          variant="ghost-muted"
          disabled={props.position === 1}
          aria-label={gt("Move {name} up", { name })}
          onClick={() => props.onMove(-1)}
        >
          <ArrowUpIcon />
        </Button>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost-muted"
          disabled={props.position === props.count}
          aria-label={gt("Move {name} down", { name })}
          onClick={() => props.onMove(1)}
        >
          <ArrowDownIcon />
        </Button>
      </span>
    </li>
  );
}
