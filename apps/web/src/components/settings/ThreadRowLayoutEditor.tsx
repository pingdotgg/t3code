import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type Modifier,
} from "@dnd-kit/core";
import { getEventCoordinates } from "@dnd-kit/utilities";
import {
  CircleDashedIcon,
  GitBranchIcon,
  GripVerticalIcon,
  PinIcon,
  TerminalIcon,
} from "lucide-react";
import {
  DEFAULT_SIDEBAR_THREAD_ROW_LAYOUT,
  SidebarThreadRowComponent,
  type SidebarThreadRowPlacement,
} from "@t3tools/contracts/settings";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import {
  THREAD_ROW_COMPONENT_LABELS,
  ThreadRowLayout,
  type ThreadRowLayoutSideProps,
  type ThreadRowLayoutRowProps,
} from "../ThreadRowLayout";
import {
  dropThreadDetail,
  threadRowBlankSpace,
  type ThreadDetailDropTarget,
} from "./ThreadRowLayoutEditor.logic";

const SAMPLE_COMPONENTS = {
  projectIcon: (
    <span className="rounded bg-foreground px-0.5 text-[10px] font-bold text-background">T3</span>
  ),
  title: (
    <span className="truncate text-sm font-medium text-foreground">Build a custom thread list</span>
  ),
  pin: <PinIcon className="size-3" />,
  activity: (
    <span className="inline-flex items-center gap-1 text-sky-600 dark:text-sky-400">
      <CircleDashedIcon className="size-4" />
      6s
    </span>
  ),
  status: <span className="text-sky-600 dark:text-sky-400">Working</span>,
  duration: "6s",
  project: "T3 Code",
  environment: "MacBook Pro",
  provider: "Codex",
  model: "GPT-5.6",
  branch: (
    <span className="inline-flex min-w-0 items-center gap-1">
      <GitBranchIcon className="size-3 shrink-0" />
      <span className="truncate">feat/thread-layout</span>
    </span>
  ),
  worktree: "Worktree",
  pullRequest: <span className="text-emerald-600 dark:text-emerald-400">#9835</span>,
  terminal: <TerminalIcon className="size-3.5" />,
  updated: "now",
  created: "2h",
  completed: "5m",
  snooze: "Tomorrow, 9 AM",
} satisfies Record<SidebarThreadRowComponent, ReactNode>;

const ROWS = [1, 2, 3] as const;
const SIDES = ["left", "right"] as const;
const rowId = (row: number, side: string) => `row:${row}:${side}`;
const edgeId = (component: SidebarThreadRowComponent, edge: "before" | "after") =>
  `edge:${component}:${edge}`;

const detectDrop: CollisionDetection = (args) => {
  const collisions = pointerWithin(args);
  const edge = collisions.find((collision) => String(collision.id).startsWith("edge:"));
  const gap = collisions.find((collision) => String(collision.id).startsWith("gap:"));
  return edge ? [edge] : gap ? [gap] : collisions;
};

// Offset only the floating copy; hit testing stays at the pointer.
const offsetDragPreview: Modifier = ({ activatorEvent, activeNodeRect, transform }) => {
  const pointer = activatorEvent ? getEventCoordinates(activatorEvent) : null;
  if (!pointer || !activeNodeRect) return transform;
  return {
    ...transform,
    x: transform.x + pointer.x - activeNodeRect.left + 12,
    y: transform.y + pointer.y - activeNodeRect.top + 20,
  };
};

function InsertionMarker({ side }: { side: "left" | "right" }) {
  return (
    <span
      aria-hidden
      data-layout-insertion
      className={cn(
        "pointer-events-none absolute inset-y-0 z-20 w-1 rounded-full bg-sky-500 ring-1 ring-background dark:bg-sky-400",
        side === "left" ? "left-0" : "right-0",
      )}
    />
  );
}

function DetailFace({
  component,
  placed,
}: {
  component: SidebarThreadRowComponent;
  placed: boolean;
}) {
  return placed ? (
    SAMPLE_COMPONENTS[component]
  ) : (
    <>
      <GripVerticalIcon aria-hidden className="size-3 shrink-0 text-muted-foreground/60" />
      <span className="flex min-w-0 flex-col items-start gap-1 text-left">
        <span className="flex min-h-5 max-w-full items-center text-xs text-secondary-label">
          {SAMPLE_COMPONENTS[component]}
        </span>
        <span className="text-[10px] text-muted-foreground">
          {THREAD_ROW_COMPONENT_LABELS[component]}
        </span>
      </span>
    </>
  );
}

function DetailChip({
  component,
  placed,
  selected,
  onSelect,
  onRemove,
  canRemove,
}: {
  component: SidebarThreadRowComponent;
  placed: boolean;
  selected: boolean;
  onSelect: () => void;
  onRemove: () => void;
  canRemove: boolean;
}) {
  const drag = useDraggable({ id: component });
  const before = useDroppable({
    id: edgeId(component, "before"),
    disabled: !placed || drag.isDragging,
  });
  const after = useDroppable({
    id: edgeId(component, "after"),
    disabled: !placed || drag.isDragging,
  });
  return (
    <div
      className={cn(
        "relative flex min-w-0 max-w-full items-stretch rounded-sm",
        !placed && "border border-border bg-background",
        selected && "ring-1 ring-inset ring-primary",
        drag.isDragging && "opacity-30",
      )}
    >
      <div
        ref={before.setNodeRef}
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-y-0 left-0 w-1/2",
          before.isOver && "z-10 bg-sky-500/15",
        )}
      >
        {before.isOver && <InsertionMarker side="left" />}
      </div>
      <button
        ref={drag.setNodeRef}
        {...drag.listeners}
        {...drag.attributes}
        type="button"
        data-layout-detail={component}
        aria-label={`Move ${THREAD_ROW_COMPONENT_LABELS[component]}`}
        aria-pressed={selected}
        onClick={onSelect}
        onKeyDown={(event) => {
          if (placed && canRemove && (event.key === "Delete" || event.key === "Backspace")) {
            event.preventDefault();
            event.stopPropagation();
            onRemove();
          }
        }}
        className={cn(
          "flex min-w-0 flex-1 touch-none items-center gap-1 rounded-sm outline-none select-none hover:bg-primary/10 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring cursor-default",
          placed ? "min-h-5 whitespace-nowrap" : "px-2 py-1.5",
        )}
      >
        <DetailFace component={component} placed={placed} />
      </button>
      <div
        ref={after.setNodeRef}
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-y-0 right-0 w-1/2",
          after.isOver && "z-10 bg-sky-500/15",
        )}
      >
        {after.isOver && <InsertionMarker side="right" />}
      </div>
    </div>
  );
}

function GapTarget({ row, alignment }: Pick<ThreadRowLayoutSideProps, "row" | "alignment">) {
  const { setNodeRef, isOver } = useDroppable({ id: `gap:${row}:${alignment}` });
  return (
    <div
      ref={setNodeRef}
      data-layout-gap={`${row}:${alignment}`}
      className={cn(
        "relative flex h-full min-w-0 flex-1 items-center justify-center rounded-sm",
        isOver && "bg-sky-500/15",
      )}
    >
      {isOver && <InsertionMarker side={alignment} />}
    </div>
  );
}

function PreviewRow({
  row,
  className,
  children,
  editing,
}: ThreadRowLayoutRowProps & { editing: boolean }) {
  const root = useRef<HTMLDivElement>(null);
  const [gap, setGap] = useState({ left: 0, width: 0 });
  useLayoutEffect(() => {
    const node = root.current;
    if (!editing || !node) return;
    const measure = () => {
      const details = (side: string) =>
        Array.from(
          node.querySelectorAll(`[data-layout-drop="${rowId(row, side)}"] [data-layout-detail]`),
          (detail) => detail.getBoundingClientRect(),
        );
      const next = threadRowBlankSpace(
        node.getBoundingClientRect(),
        details("left"),
        details("right"),
      );
      setGap((previous) =>
        previous.left === next.left && previous.width === next.width ? previous : next,
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [editing, row, children]);
  return (
    <div ref={root} className={cn(className, "relative")}>
      {children}
      {editing && gap.width > 0 && (
        <div className="pointer-events-none absolute inset-y-0 z-10 flex" style={gap}>
          <GapTarget row={row} alignment="left" />
          <GapTarget row={row} alignment="right" />
        </div>
      )}
    </div>
  );
}

function PreviewSide({
  row,
  alignment,
  className,
  children,
  empty,
  picking,
  editing,
  onPlace,
}: ThreadRowLayoutSideProps & {
  picking: boolean;
  editing: boolean;
  onPlace: () => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: rowId(row, alignment) });
  if (empty && !editing && !picking) return null;
  return (
    <div
      ref={setNodeRef}
      data-layout-drop={rowId(row, alignment)}
      className={cn(
        className,
        "relative min-h-5 rounded-sm",
        empty && editing && "min-w-12",
        isOver && "bg-sky-500/15",
      )}
    >
      {children}
      {isOver && <InsertionMarker side={empty ? alignment : "right"} />}
      {empty && editing ? (
        <button
          type="button"
          disabled={!picking}
          onClick={onPlace}
          aria-label={`Place selected detail in row ${row}, ${alignment}`}
          className="w-full border-b border-dashed border-muted-foreground/30 text-[10px] text-muted-foreground/60 focus-visible:ring-1 focus-visible:ring-ring"
        >
          {alignment === "left" ? `Row ${row}` : "Right"}
        </button>
      ) : picking ? (
        <button
          type="button"
          onClick={onPlace}
          aria-label={`Place selected detail in row ${row}, ${alignment}`}
          className="sr-only focus:not-sr-only focus:absolute focus:inset-0 focus:bg-sidebar focus:text-xs"
        >
          Place here
        </button>
      ) : null}
    </div>
  );
}

function AvailableDetails({
  children,
  picking,
  onHide,
}: {
  children: ReactNode;
  picking: boolean;
  onHide: () => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: "available" });
  return (
    <div
      ref={setNodeRef}
      data-layout-drop="available"
      className={cn("min-w-0 space-y-2 rounded-lg", isOver && "bg-primary/10 ring-1 ring-primary")}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-xs font-medium text-muted-foreground">Available details</h3>
        {picking ? (
          <Button variant="outline" size="sm" onClick={onHide}>
            Hide selected detail
          </Button>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-2">{children}</div>
    </div>
  );
}

export function ThreadRowLayoutEditor({
  layoutId,
  layout,
  onChange,
  footer,
  renderHeader,
  showResetLayout = true,
  resetLayout = DEFAULT_SIDEBAR_THREAD_ROW_LAYOUT,
  showAvailableDetails = true,
}: {
  layoutId: string;
  layout: ReadonlyArray<SidebarThreadRowPlacement>;
  onChange: (layout: ReadonlyArray<SidebarThreadRowPlacement>) => void;
  footer?: ReactNode;
  renderHeader: (preview: ReactNode) => ReactNode;
  showResetLayout?: boolean;
  resetLayout?: ReadonlyArray<SidebarThreadRowPlacement>;
  showAvailableDetails?: boolean;
}) {
  const [dragging, setDragging] = useState<SidebarThreadRowComponent | null>(null);
  const [selection, setSelection] = useState<{
    layoutId: string;
    component: SidebarThreadRowComponent;
  } | null>(null);
  const picked = selection?.layoutId === layoutId ? selection.component : null;
  const setPicked = (component: SidebarThreadRowComponent | null) =>
    setSelection(component ? { layoutId, component } : null);
  const [message, setMessage] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const focusAfterChange = useRef<SidebarThreadRowComponent | null>(null);
  useLayoutEffect(() => {
    const component = focusAfterChange.current;
    if (!component) return;
    root.current?.querySelector<HTMLButtonElement>(`[data-layout-detail="${component}"]`)?.focus();
    focusAfterChange.current = null;
  }, [layout]);
  useEffect(() => {
    if (!dragging) return;
    // Let the drag sensor cancel before Settings handles Escape as navigation.
    const keepInEditor = (event: KeyboardEvent) => {
      if (event.key === "Escape") event.preventDefault();
    };
    window.addEventListener("keydown", keepInEditor, true);
    return () => window.removeEventListener("keydown", keepInEditor, true);
  }, [dragging]);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const targets = new Map<string, ThreadDetailDropTarget>([["available", { kind: "hide" }]]);
  for (const row of ROWS)
    for (const alignment of SIDES) {
      targets.set(rowId(row, alignment), { kind: "place", row, alignment });
      const first = layout.find(
        (item) => item.row === row && item.alignment === alignment && item.component !== dragging,
      );
      targets.set(`gap:${row}:${alignment}`, {
        kind: "place",
        row,
        alignment,
        ...(alignment === "right" && first ? { relativeTo: first.component, edge: "before" } : {}),
      });
    }
  for (const item of layout)
    for (const edge of ["before", "after"] as const)
      targets.set(edgeId(item.component, edge), {
        kind: "place",
        row: item.row,
        alignment: item.alignment,
        relativeTo: item.component,
        edge,
      });

  const place = (
    component: SidebarThreadRowComponent,
    target: ThreadDetailDropTarget | null,
    restoreFocus = false,
  ) => {
    const next = dropThreadDetail(layout, component, target);
    if (next !== layout) {
      if (restoreFocus) focusAfterChange.current = component;
      onChange(next);
    }
    setPicked(null);
    setMessage(
      target?.kind === "hide"
        ? next === layout
          ? "Keep at least one detail visible."
          : `${THREAD_ROW_COMPONENT_LABELS[component]} hidden.`
        : target
          ? `${THREAD_ROW_COMPONENT_LABELS[component]} placed in row ${target.row}, ${target.alignment}.`
          : "Move cancelled.",
    );
    if (restoreFocus && next === layout)
      root.current
        ?.querySelector<HTMLButtonElement>(`[data-layout-detail="${component}"]`)
        ?.focus();
  };
  const chip = (component: SidebarThreadRowComponent, placed: boolean) => (
    <DetailChip
      key={component}
      component={component}
      placed={placed}
      selected={picked === component}
      canRemove={layout.length > 1}
      onSelect={() => {
        if (picked && picked !== component && placed) {
          place(picked, targets.get(edgeId(component, "before")) ?? null, true);
        } else {
          setPicked(picked === component ? null : component);
          setMessage(
            picked === component
              ? "Move cancelled."
              : `${THREAD_ROW_COMPONENT_LABELS[component]} selected. Choose a row side or another detail to place it.`,
          );
        }
      }}
      onRemove={() => place(component, { kind: "hide" }, true)}
    />
  );

  const preview = (
    <div className="w-fit min-w-0 max-w-full overflow-x-auto">
      <div
        className="w-[calc(var(--sidebar-width)-2*var(--sidebar-content-inset)-2px)] rounded-md bg-sidebar px-2.5 py-1.5 ring-1 ring-inset ring-border"
        aria-label="Thread layout preview"
      >
        <ThreadRowLayout
          layout={layout}
          showEmptyRows={dragging !== null}
          components={Object.fromEntries(
            layout.map(({ component }) => [component, chip(component, true)]),
          )}
          renderRow={(props) => <PreviewRow {...props} editing={dragging !== null} />}
          renderSide={(props) => (
            <PreviewSide
              {...props}
              editing={dragging !== null}
              picking={picked !== null}
              onPlace={() => {
                if (picked)
                  place(
                    picked,
                    { kind: "place", row: props.row, alignment: props.alignment },
                    true,
                  );
              }}
            />
          )}
        />
      </div>
    </div>
  );

  return (
    <DndContext
      sensors={sensors}
      autoScroll={{ layoutShiftCompensation: false }}
      collisionDetection={detectDrop}
      accessibility={{
        screenReaderInstructions: {
          draggable:
            "Press Enter or Space to select a detail. Use arrow keys to change its row or side, or select another detail to insert before it. Escape cancels.",
        },
      }}
      onDragStart={({ active }) => {
        setPicked(null);
        setDragging(SidebarThreadRowComponent.literals.find((id) => id === active.id) ?? null);
      }}
      onDragCancel={() => {
        setDragging(null);
        setMessage("Move cancelled.");
      }}
      onDragEnd={({ active, over }) => {
        setDragging(null);
        const component = SidebarThreadRowComponent.literals.find((id) => id === active.id);
        if (component) place(component, over ? (targets.get(String(over.id)) ?? null) : null);
      }}
    >
      <div
        ref={root}
        className="space-y-4 rounded-xl px-3 pt-3 pb-1 sm:px-4 cursor-default [&_*]:cursor-default"
        onKeyDown={(event) => {
          if (
            picked &&
            event.target instanceof Element &&
            event.target.closest("[data-layout-detail]") &&
            ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)
          ) {
            event.preventDefault();
            event.stopPropagation();
            const current = layout.find((item) => item.component === picked);
            const row = current?.row ?? 1;
            const alignment = current?.alignment ?? "left";
            place(
              picked,
              {
                kind: "place",
                row:
                  event.key === "ArrowUp"
                    ? row === 3
                      ? 2
                      : 1
                    : event.key === "ArrowDown"
                      ? row === 1
                        ? 2
                        : 3
                      : row,
                alignment:
                  event.key === "ArrowLeft"
                    ? "left"
                    : event.key === "ArrowRight"
                      ? "right"
                      : alignment,
              },
              true,
            );
          }
          if (event.key === "Escape" && dragging) event.preventDefault();
          if (event.key === "Escape" && picked) {
            event.preventDefault();
            event.stopPropagation();
            setPicked(null);
            setMessage("Move cancelled.");
          }
        }}
      >
        <div className="space-y-4">
          {renderHeader(preview)}
          {showAvailableDetails && (
            <AvailableDetails
              picking={layout.length > 1 && layout.some((item) => item.component === picked)}
              onHide={() => {
                if (picked) place(picked, { kind: "hide" }, true);
              }}
            >
              {SidebarThreadRowComponent.literals
                .filter((component) => !layout.some((item) => item.component === component))
                .map((component) => chip(component, false))}
            </AvailableDetails>
          )}
        </div>
        {(showResetLayout || footer) && (
          <div className="flex flex-wrap items-center gap-2">
            {showResetLayout && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setPicked(null);
                  onChange(resetLayout);
                }}
              >
                Reset layout
              </Button>
            )}
            {footer}
          </div>
        )}
        <span className="sr-only" role="status">
          {message}
        </span>
      </div>
      <DragOverlay
        dropAnimation={null}
        modifiers={[offsetDragPreview]}
        style={{ pointerEvents: "none" }}
      >
        {dragging ? (
          <div
            data-layout-drag-preview
            className="flex w-max max-w-64 items-center gap-1.5 rounded-md border border-primary bg-background px-2 py-1.5 text-xs whitespace-nowrap shadow-lg"
          >
            <DetailFace component={dragging} placed />
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
