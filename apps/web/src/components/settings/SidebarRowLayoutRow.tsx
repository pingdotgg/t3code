import {
  DndContext,
  type DragMoveEvent,
  type DragStartEvent,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useDraggable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { T, useGT, useMessages } from "gt-react";
import {
  BotIcon,
  GitBranchIcon,
  GripVerticalIcon,
  LaptopIcon,
  PlusIcon,
  TerminalIcon,
} from "lucide-react";
import { type ReactNode, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { cn } from "~/lib/utils";
import { updateClientSettings, useClientSettings } from "../../hooks/useSettings";
import { IssueGlyph } from "../issue/issuePresentation";
import { ProjectMonogram } from "../ProjectMonogram";
import { PULL_REQUEST_STATE_PRESENTATION } from "../pullRequest/pullRequestIcons";
import {
  DEFAULT_SIDEBAR_ROW_LAYOUT,
  SIDEBAR_ROW_ITEMS,
  type SidebarRowItemId,
  type SidebarRowLayout,
  type SidebarRowLine,
  type SidebarRowToken,
  findSidebarRowToken,
  insertSidebarRowSpacer,
  isDefaultSidebarRowLayout,
  moveSidebarRowToken,
  resolveSidebarRowLayout,
  resolveSidebarRowLines,
  setSidebarRowLineKept,
  storedSidebarRowLayout,
} from "../sidebar/sidebarRowLayout";
import { Button } from "../ui/button";
import { Radio, RadioGroup } from "../ui/radio-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "../ui/dialog";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";

function saveLayout(layout: SidebarRowLayout) {
  updateClientSettings({ sidebarRowLayout: storedSidebarRowLayout(layout) });
}

function useItemLabel() {
  const m = useMessages();
  return (id: SidebarRowItemId) =>
    m(SIDEBAR_ROW_ITEMS.find((item) => item.id === id)?.label ?? SIDEBAR_ROW_ITEMS[0].label);
}

export function SidebarRowLayoutRow() {
  const gt = useGT();
  const searchableSetting = useSearchableSetting();
  const isDefault = isDefaultSidebarRowLayout(
    resolveSidebarRowLayout(useClientSettings((settings) => settings.sidebarRowLayout)),
  );
  const reset = () => saveLayout(DEFAULT_SIDEBAR_ROW_LAYOUT);
  return (
    <SettingsRow
      {...searchableSetting("sidebar-row-layout")}
      description={gt("Choose what sidebar thread cards show, and where.")}
      resetAction={
        isDefault ? null : (
          <SettingResetButton
            ariaLabel={gt("Reset sidebar thread rows to default")}
            onClick={reset}
          />
        )
      }
      control={
        <Dialog>
          <DialogTrigger
            render={<Button type="button" variant="outline" size="sm" className="w-full sm:w-40" />}
          >
            <T>Customize</T>
          </DialogTrigger>
          <DialogPopup className="max-w-3xl">
            <DialogHeader>
              <DialogTitle>
                <T>Sidebar thread rows</T>
              </DialogTitle>
              <DialogDescription>
                <T>Choose what each thread row shows, and where.</T>
              </DialogDescription>
            </DialogHeader>
            <DialogPanel>
              <SidebarRowLayoutEditor />
            </DialogPanel>
            <DialogFooter variant="bare">
              <Button type="button" variant="ghost" disabled={isDefault} onClick={reset}>
                <T>Reset</T>
              </Button>
              <DialogClose render={<Button type="button" />}>
                <T>Done</T>
              </DialogClose>
            </DialogFooter>
          </DialogPopup>
        </Dialog>
      }
    />
  );
}

const LINES = ["top", "middle", "bottom", "hidden"] as const;

function SidebarRowLayoutEditor() {
  const gt = useGT();
  const label = useItemLabel();
  const layout = resolveSidebarRowLayout(
    useClientSettings((settings) => settings.sidebarRowLayout),
  );
  // Nothing moves while dragging: an insertion mark shows the drop spot, and the layout changes once
  // on drop. Positions are measured when the drag starts so the mark cannot shift its own target.
  const [drag, setDrag] = useState<{ key: string; target: DropTarget | null } | null>(null);
  const geometryRef = useRef<DragGeometry | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor),
  );

  const handleDragStart = ({ active, activatorEvent }: DragStartEvent) => {
    geometryRef.current = rootRef.current ? measureGeometry(rootRef.current, activatorEvent) : null;
    setDrag({ key: String(active.id), target: null });
  };
  const handleDragMove = ({ active, delta }: DragMoveEvent) => {
    const geometry = geometryRef.current;
    if (!geometry) return;
    const key = String(active.id);
    const target = dropTargetAt(geometry, key, findSidebarRowToken(layout, key)?.token.id, {
      x: geometry.origin.x + delta.x,
      y: geometry.origin.y + delta.y,
    });
    setDrag((current) =>
      current?.key === key &&
      current.target?.line === target?.line &&
      current.target?.index === target?.index
        ? current
        : { key, target },
    );
  };
  const endDrag = () => {
    geometryRef.current = null;
    setDrag(null);
  };
  const handleDragEnd = () => {
    if (drag?.target)
      saveLayout(moveSidebarRowToken(layout, drag.key, drag.target.line, drag.target.index));
    endDrag();
  };
  const draggedToken = drag ? findSidebarRowToken(layout, drag.key)?.token : undefined;
  const lineLabels: Record<SidebarRowLine, string> = {
    top: gt("Top", { $context: "sidebar row line" }),
    middle: gt("Middle", { $context: "sidebar row line" }),
    bottom: gt("Bottom", { $context: "sidebar row line" }),
    hidden: gt("Hidden", { $context: "sidebar row items that are not shown" }),
  };

  return (
    <DndContext
      sensors={sensors}
      // Scrolling mid-drag would move everything away from the measured positions.
      autoScroll={false}
      accessibility={{
        announcements: {
          onDragStart: ({ active }) =>
            gt("Picked up {item}.", { item: label(tokenIdOf(layout, active.id)) }),
          onDragOver: () => undefined,
          onDragMove: () => undefined,
          onDragEnd: ({ active }) =>
            gt("Dropped {item}.", { item: label(tokenIdOf(layout, active.id)) }),
          onDragCancel: ({ active }) =>
            gt("Put {item} back.", { item: label(tokenIdOf(layout, active.id)) }),
        },
      }}
      onDragStart={handleDragStart}
      onDragMove={handleDragMove}
      onDragEnd={handleDragEnd}
      onDragCancel={endDrag}
    >
      <div ref={rootRef} className="flex flex-col gap-5">
        <section className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>
              <T>Preview</T>
            </span>
            <span className="text-muted-foreground/70">
              <T>Sample thread</T>
            </span>
          </div>
          <div className="flex justify-center rounded-lg border border-border/60 bg-muted/60 px-4 py-5">
            <ul role="presentation" className="flex w-80 max-w-full flex-col gap-1">
              <SampleRow sample="full" layout={layout} />
              <SampleRow sample="sparse" layout={layout} />
            </ul>
          </div>
        </section>
        <section className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-muted-foreground">
              <T>Layout · drag items to move them</T>
            </span>
            <Button
              type="button"
              size="xs"
              variant="ghost-muted"
              onClick={() =>
                saveLayout(
                  insertSidebarRowSpacer(layout, "bottom", Number.POSITIVE_INFINITY).layout,
                )
              }
            >
              <PlusIcon aria-hidden />
              <T context="flexible empty space in a layout">Spacer</T>
            </Button>
          </div>
          <div className="flex flex-col gap-1.5">
            {LINES.map((line) => (
              <Lane
                key={line}
                line={line}
                label={lineLabels[line]}
                tokens={layout[line]}
                draggingKey={drag?.key ?? null}
                insertAt={drag?.target?.line === line ? drag.target.index : null}
                refusesDrag={line === "hidden" && draggedToken?.id === "title"}
              />
            ))}
          </div>
        </section>
        <RowHeightChoice layout={layout} />
      </div>
      {/* The dialog animates with a transform, which would offset a fixed overlay inside it. */}
      {createPortal(
        <DragOverlay dropAnimation={null} zIndex={100}>
          {draggedToken ? <ItemChip token={draggedToken} lifted /> : null}
        </DragOverlay>,
        document.body,
      )}
    </DndContext>
  );
}

const tokenIdOf = (layout: SidebarRowLayout, key: string | number) =>
  findSidebarRowToken(layout, String(key))?.token.id ?? "spacer";

function Lane(props: {
  line: SidebarRowLine;
  label: string;
  tokens: ReadonlyArray<SidebarRowToken>;
  draggingKey: string | null;
  insertAt: number | null;
  refusesDrag: boolean;
}) {
  const hidden = props.line === "hidden";
  // The insertion index skips the dragged item, matching how a move removes it first.
  const nodes: ReactNode[] = [];
  let position = 0;
  const marker = <span key="insert" aria-hidden className={INSERTION_MARK_CLASS_NAME} />;
  for (const token of props.tokens) {
    if (props.insertAt === position && token.key !== props.draggingKey) nodes.push(marker);
    if (token.key !== props.draggingKey) position++;
    nodes.push(
      <DraggableChip
        key={token.key}
        token={token}
        line={props.line}
        dragging={token.key === props.draggingKey}
      />,
    );
  }
  if (props.insertAt !== null && props.insertAt >= position) nodes.push(marker);
  return (
    <div
      data-layout-line={props.line}
      role="group"
      aria-label={props.label}
      className={cn(
        "flex min-h-11 items-center gap-3 rounded-lg px-3 py-1.5",
        hidden ? "border border-dashed border-border" : "bg-muted/50",
        props.insertAt !== null && "bg-accent/50 ring-1 ring-ring/50 ring-inset",
        props.refusesDrag && "opacity-50",
      )}
    >
      <span className="w-14 shrink-0 text-xs text-muted-foreground">{props.label}</span>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
        {nodes}
        {hidden && props.tokens.length === 0 && props.insertAt === null ? (
          <span className="text-xs text-muted-foreground/70">
            <T>Drop an item here to hide it.</T>
          </span>
        ) : null}
      </div>
    </div>
  );
}

function DraggableChip(props: { token: SidebarRowToken; line: SidebarRowLine; dragging: boolean }) {
  const gt = useGT();
  const label = useItemLabel();
  const { attributes, listeners, setNodeRef } = useDraggable({ id: props.token.key });
  const name = label(props.token.id);
  const chip = (
    <span
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      data-layout-key={props.token.key}
      data-layout-item-line={props.line}
      aria-label={gt("Move {item}", { item: name })}
      className={cn(
        "cursor-grab touch-none rounded-md outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring active:cursor-grabbing",
        props.token.id === "spacer" && "min-w-16 flex-1",
        props.dragging && "opacity-40",
      )}
    >
      <ItemChip token={props.token} />
    </span>
  );
  if (props.token.id === "spacer") return chip;
  return (
    <Tooltip>
      <TooltipTrigger render={chip} />
      <TooltipPopup side="top">{name}</TooltipPopup>
    </Tooltip>
  );
}

/** A chip shows the item as the sample row draws it, so each one is easy to match. */
function ItemChip(props: { token: SidebarRowToken; lifted?: boolean }) {
  if (props.token.id === "spacer") {
    return (
      <span className="flex h-7 w-full items-center justify-center rounded-md border border-dashed border-muted-foreground/35 text-xs text-muted-foreground/60">
        <T context="flexible empty space in a layout">space</T>
      </span>
    );
  }
  return (
    <span
      className={cn(
        "inline-flex h-7 max-w-56 items-center gap-1.5 rounded-md border border-border bg-background ps-1 pe-2 text-xs",
        props.lifted && "shadow-md",
      )}
    >
      <GripVerticalIcon aria-hidden className="size-3 shrink-0 text-muted-foreground/50" />
      <SampleItem token={props.token} sample="full" />
    </span>
  );
}

type Sample = "full" | "sparse";

/** The sample thread's value for each item; the sparse thread has only its project and title. */
function SampleItem(props: { token: SidebarRowToken; sample: Sample }) {
  const gt = useGT();
  const full = props.sample === "full";
  switch (props.token.id) {
    case "projectIcon":
      return <ProjectMonogram text="T3" color="blue" className="size-4 shrink-0" />;
    case "projectName":
      return <span className="min-w-0 truncate text-secondary-label">t3code</span>;
    case "title":
      return (
        <span className="min-w-0 truncate font-medium text-foreground">
          {full ? gt("Add dynamic workflows to mobile") : gt("Quick question about the sidebar")}
        </span>
      );
    case "time":
      return (
        <span className="shrink-0 text-secondary-label tabular-nums">
          {full ? gt("3h", { $context: "3 hours ago" }) : gt("2d", { $context: "2 days ago" })}
        </span>
      );
    case "branch":
      return full ? (
        <span className="flex min-w-0 items-center gap-1 text-secondary-label">
          <GitBranchIcon aria-hidden className="size-3 shrink-0" />
          <span className="min-w-0 truncate">t3/mobile-workflows</span>
        </span>
      ) : null;
    case "terminals":
      return full ? (
        <span className="inline-flex shrink-0 items-center gap-1 text-secondary-label">
          <TerminalIcon aria-hidden className="size-3" />2
        </span>
      ) : null;
    case "pullRequest":
      return full ? (
        <span
          className={cn(
            "inline-flex shrink-0 items-center gap-1",
            PULL_REQUEST_STATE_PRESENTATION.open.toneClassName,
          )}
        >
          <PULL_REQUEST_STATE_PRESENTATION.open.Icon aria-hidden className="size-3" />
          18642
        </span>
      ) : null;
    case "issues":
      return full ? (
        <span className="inline-flex shrink-0 items-center gap-1 text-secondary-label">
          <IssueGlyph.issue aria-hidden className="size-3" />2
        </span>
      ) : null;
    case "environment":
      return full ? (
        <span className="flex min-w-0 items-center gap-1 text-secondary-label">
          <LaptopIcon aria-hidden className="size-3.5 shrink-0" />
          {props.token.form === "compact" ? null : (
            <span className="min-w-0 truncate">
              {gt("Studio Mac", { $context: "sample computer name" })}
            </span>
          )}
        </span>
      ) : null;
    case "agents":
      return full ? (
        <span className="inline-flex shrink-0 items-center gap-1 text-secondary-label">
          <BotIcon aria-hidden className="size-3" />3
        </span>
      ) : null;
    case "spacer":
      return <span className="min-w-0 flex-1" />;
  }
}

/** One sample thread drawn with the current layout, folding lines the way a real row does. */
function SampleRow(props: { sample: Sample; layout: SidebarRowLayout }) {
  const { layout, sample } = props;
  const titleLine =
    (["top", "middle", "bottom"] as const).find((line) =>
      layout[line].some((token) => token.id === "title"),
    ) ?? "middle";
  const lines = resolveSidebarRowLines({
    lines: layout,
    titleLine,
    keepLines: layout.keepLines,
    hasContent: (token) =>
      sample === "full" || ["projectIcon", "projectName", "title", "time"].includes(token.id),
  });
  return (
    <li
      aria-hidden
      className="list-none rounded-md border border-sidebar-border/60 bg-sidebar px-2.5 py-2 text-sidebar-foreground"
    >
      {(["top", "middle", "bottom"] as const).map((line) => {
        const tokens = lines[line];
        if (tokens === null) return null;
        return (
          <div
            key={line}
            className={cn(
              "flex h-5 min-w-0 items-center gap-1.5 text-xs",
              line !== "top" && "mt-0.5",
            )}
          >
            {tokens.map((token) => (
              <SampleItem key={token.key} token={token} sample={sample} />
            ))}
          </div>
        );
      })}
    </li>
  );
}

/** Two sketched choices: rows that fold empty lines, or rows that all keep every line. */
function RowHeightChoice(props: { layout: SidebarRowLayout }) {
  const gt = useGT();
  const fixed = props.layout.keepLines.length > 0;
  const setFixed = (kept: boolean) =>
    saveLayout(
      setSidebarRowLineKept(setSidebarRowLineKept(props.layout, "middle", kept), "bottom", kept),
    );
  return (
    <section className="flex flex-col gap-2">
      <span id="sidebar-row-height-label" className="text-xs text-muted-foreground">
        <T>Row height</T>
      </span>
      <RadioGroup
        aria-labelledby="sidebar-row-height-label"
        value={fixed ? "same" : "fit"}
        onValueChange={(value) => setFixed(value === "same")}
        className="grid grid-cols-1 sm:grid-cols-2"
      >
        {(["fit", "same"] as const).map((choice) => (
          <label
            key={choice}
            className={cn(
              "flex cursor-pointer items-center gap-3 rounded-lg border p-2.5 text-sm",
              (choice === "same") === fixed ? "border-ring/60 bg-accent/40" : "border-border",
            )}
          >
            <HeightSketch same={choice === "same"} />
            <Radio value={choice} />
            {choice === "same" ? gt("Same height") : gt("Fit each thread")}
          </label>
        ))}
      </RadioGroup>
    </section>
  );
}

function HeightSketch(props: { same: boolean }) {
  // The middle thread has nothing for its last line: it folds away, or keeps an empty line.
  return (
    <span
      aria-hidden
      className="flex w-20 shrink-0 flex-col gap-1 rounded-md bg-muted p-1.5 ring-1 ring-border ring-inset"
    >
      {(["full", "sparse", "full-last"] as const).map((row) => {
        const sparse = row === "sparse";
        return (
          <span
            key={row}
            className="flex flex-col gap-1 rounded-sm bg-background px-1.5 py-1.5 ring-1 ring-border/70"
          >
            <span className="h-0.5 w-3/5 rounded-full bg-muted-foreground/50" />
            <span className="h-0.5 w-full rounded-full bg-foreground/70" />
            {sparse && !props.same ? null : (
              <span
                className={cn("h-0.5 w-4/5 rounded-full", sparse ? "" : "bg-muted-foreground/50")}
              />
            )}
          </span>
        );
      })}
    </span>
  );
}

const INSERTION_MARK_CLASS_NAME =
  // Negative margins cancel the lane's gap, so the mark does not push items aside.
  "-mx-[4px] h-5 w-0.5 shrink-0 rounded-full bg-primary";

type DropTarget = { line: SidebarRowLine; index: number };

interface DragGeometry {
  origin: { x: number; y: number };
  lines: ReadonlyArray<{ line: SidebarRowLine; rect: DOMRect }>;
  items: ReadonlyArray<{ key: string; line: SidebarRowLine; rect: DOMRect }>;
}

function measureGeometry(root: HTMLElement, activatorEvent: Event): DragGeometry {
  const pointer = activatorEvent as PointerEvent;
  return {
    origin: { x: pointer.clientX ?? 0, y: pointer.clientY ?? 0 },
    lines: [...root.querySelectorAll<HTMLElement>("[data-layout-line]")].map((element) => ({
      line: element.dataset.layoutLine as SidebarRowLine,
      rect: element.getBoundingClientRect(),
    })),
    items: [...root.querySelectorAll<HTMLElement>("[data-layout-key]")].map((element) => ({
      key: element.dataset.layoutKey ?? "",
      line: element.dataset.layoutItemLine as SidebarRowLine,
      rect: element.getBoundingClientRect(),
    })),
  };
}

/** The lane under the pointer, and how many of its other items sit before the pointer. */
function dropTargetAt(
  geometry: DragGeometry,
  key: string,
  tokenId: SidebarRowItemId | undefined,
  point: { x: number; y: number },
): DropTarget | null {
  const lane = geometry.lines.find(
    ({ rect }) => point.y >= rect.top - 4 && point.y <= rect.bottom + 4,
  );
  if (!lane) return null;
  if (lane.line === "hidden" && tokenId === "title") return null;
  const index = geometry.items.filter(
    (item) =>
      item.line === lane.line &&
      item.key !== key &&
      (item.rect.bottom < point.y ||
        (item.rect.top <= point.y && item.rect.left + item.rect.width / 2 < point.x)),
  ).length;
  return { line: lane.line, index };
}
