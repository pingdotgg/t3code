import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { restrictToFirstScrollableAncestor, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useGT, useMessages } from "gt-react";
import { GripVerticalIcon } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";

import { updateClientSettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import {
  moveThreadDetailsBlock,
  THREAD_DETAILS_BLOCKS,
  type ThreadDetailsBlockId,
} from "./threadDetailsItems";

type Block = (typeof THREAD_DETAILS_BLOCKS)[number];

/** Renders the card's blocks in the saved order; each one drags by the grip in its left gutter. */
export function ThreadDetailsBlocks(props: {
  readonly order: ReadonlyArray<ThreadDetailsBlockId>;
  readonly blocks: Readonly<Record<ThreadDetailsBlockId, ReactNode>>;
  readonly density: "full" | "compact" | "essential";
}) {
  const gt = useGT();
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const listRef = useRef<HTMLDivElement>(null);
  const [hiddenWhileDragging, setHiddenWhileDragging] = useState<ReadonlySet<string>>(new Set());
  const shown = props.order
    .filter((id) => props.blocks[id] !== null)
    .map((id) => THREAD_DETAILS_BLOCKS.find((block) => block.id === id)!);
  // Neighbors of one group share a section, as the card laid them out before blocks could move.
  const runs: Block[][] = [];
  for (const block of shown) {
    const last = runs.at(-1);
    if (last && block.group !== null && last[0]!.group === block.group) last.push(block);
    else runs.push([block]);
  }
  // A block that renders nothing is hidden by CSS. Left in the list, its zero-size box throws
  // its neighbors' drag offsets off the card, so a drag skips it. Content can come and go mid-drag.
  const syncHiddenBlocks = () => {
    const blocks = listRef.current?.querySelectorAll<HTMLElement>("[data-thread-details-block-id]");
    const hidden = [...(blocks ?? [])]
      .filter((block) => block.getClientRects().length === 0)
      .map((block) => block.dataset.threadDetailsBlockId!);
    setHiddenWhileDragging((current) =>
      current.size === hidden.length && hidden.every((id) => current.has(id))
        ? current
        : new Set(hidden),
    );
  };
  const handleDragEnd = (event: DragEndEvent) => {
    setHiddenWhileDragging(new Set());
    if (event.over === null || event.active.id === event.over.id) return;
    updateClientSettings({
      threadDetailsOrder: moveThreadDetailsBlock(
        props.order,
        event.active.id as ThreadDetailsBlockId,
        event.over.id as ThreadDetailsBlockId,
      ),
    });
  };
  const groupTitles = { workspace: gt("Workspace"), versionControl: gt("Version Control") };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      modifiers={[restrictToVerticalAxis, restrictToFirstScrollableAncestor]}
      onDragStart={syncHiddenBlocks}
      onDragMove={syncHiddenBlocks}
      onDragEnd={handleDragEnd}
      onDragCancel={() => setHiddenWhileDragging(new Set())}
    >
      <SortableContext
        items={shown.map((block) => block.id).filter((id) => !hiddenWhileDragging.has(id))}
        strategy={verticalListSortingStrategy}
      >
        <div ref={listRef} className="contents">
          {runs.map((run, index) => {
            const group = run[0]!.group;
            const rows = run.map((block) => (
              <SortableBlock
                key={block.id}
                block={block}
                inset={group === null ? "section" : "row"}
                disabled={hiddenWhileDragging.has(block.id)}
              >
                {props.blocks[block.id]}
              </SortableBlock>
            ));
            return (
              <div
                // Stable while blocks move within a run, so the section keeps its children's state.
                key={
                  group === null
                    ? run[0]!.id
                    : `${group}-${runs.slice(0, index).filter((other) => other[0]!.group === group).length}`
                }
                data-thread-details-unit
                // A unit hides when its blocks render nothing; a divider follows only a unit that shows.
                className={cn(
                  "not-has-[[data-thread-details-block]:not(:empty)]:hidden",
                  (group !== "versionControl" || props.density === "full") &&
                    "border-border/65 [[data-thread-details-unit]:has([data-thread-details-block]:not(:empty))~&]:border-t",
                )}
              >
                {group === null ? (
                  rows
                ) : (
                  <ThreadDetailsSection
                    headingId={`thread-details-${run[0]!.id}-group-heading`}
                    title={groupTitles[group]}
                    showHeading={false}
                    separated={false}
                  >
                    <div className="flex flex-col">{rows}</div>
                  </ThreadDetailsSection>
                )}
              </div>
            );
          })}
        </div>
      </SortableContext>
    </DndContext>
  );
}

function SortableBlock(props: {
  readonly block: Block;
  readonly inset: "section" | "row";
  readonly disabled: boolean;
  readonly children: ReactNode;
}) {
  const gt = useGT();
  const m = useMessages();
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: props.block.id,
    disabled: { draggable: props.disabled, droppable: props.disabled },
    // Hidden blocks leave the list mid-drag, so a drop shifts indices; animating that misplaces blocks.
    animateLayoutChanges: () => false,
  });
  return (
    <div
      ref={setNodeRef}
      data-thread-details-block-id={props.block.id}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(
        "group/block relative has-[>div:last-child:empty]:hidden",
        isDragging && "z-10 rounded-lg bg-popover shadow-md",
      )}
    >
      <button
        type="button"
        ref={setActivatorNodeRef}
        // Inline: the grip must stay out of flow even without styles, or it skews the card's measured height.
        style={{ position: "absolute" }}
        {...attributes}
        {...listeners}
        aria-label={gt("Move {name}", { name: m(props.block.label) })}
        className={cn(
          "z-10 flex h-8 w-2.5 cursor-grab touch-none items-center justify-center rounded-sm text-muted-foreground/70 opacity-0 outline-none hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring group-hover/block:opacity-100 active:cursor-grabbing pointer-coarse:hidden",
          props.inset === "section" ? "start-0 top-2" : "-start-2 top-0",
          isDragging && "opacity-100",
        )}
      >
        <GripVerticalIcon className="size-3" aria-hidden />
      </button>
      <div data-thread-details-block>{props.children}</div>
    </div>
  );
}
