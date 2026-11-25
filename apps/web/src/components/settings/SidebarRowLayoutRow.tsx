import {
  DndContext,
  type DragMoveEvent,
  type DragStartEvent,
  DragOverlay,
  PointerSensor,
  useDraggable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { useAtomValue } from "@effect/atom-react";
import { T, useGT, useMessages } from "gt-react";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  BotIcon,
  FolderIcon,
  GitBranchIcon,
  ImageIcon,
  MonitorIcon,
  MoveHorizontalIcon,
  PlusIcon,
  TerminalIcon,
  TypeIcon,
} from "lucide-react";
import { type KeyboardEvent, type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { cn } from "~/lib/utils";
import { updateClientSettings, useClientSettings } from "../../hooks/useSettings";
import { useSidebarProjectGroups } from "../../hooks/useSidebarProjectGroups";
import { useProjects, useThreadShells } from "../../state/entities";
import { useEnvironmentIdentities, useEnvironmentMachines } from "../../state/environments";
import { IssueGlyph } from "../issue/issuePresentation";
import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { sidebarProviderEntriesAtom } from "../Sidebar";
import { SidebarThreadRow } from "../sidebar/SidebarThreadRow";
import { projectGroupsSpanEnvironments } from "../../sidebarProjectGrouping";
import {
  DEFAULT_SIDEBAR_ROW_LAYOUT,
  SIDEBAR_ROW_ITEMS,
  SIDEBAR_ROW_ITEM_FORMS,
  SidebarRowLayoutEditingContext,
  type SidebarRowItemId,
  type SidebarRowLayout,
  type SidebarRowLayoutItem,
  type SidebarRowLine,
  type SidebarRowToken,
  findSidebarRowToken,
  insertSidebarRowSpacer,
  isDefaultSidebarRowLayout,
  moveSidebarRowToken,
  resolveSidebarRowLayout,
  setSidebarRowTokenForm,
  storedSidebarRowLayout,
  withoutSidebarRowItem,
} from "../sidebar/sidebarRowLayout";
import { Button } from "../ui/button";
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

const ITEM_ICONS: Record<SidebarRowItemId, typeof FolderIcon> = {
  title: TypeIcon,
  projectIcon: ImageIcon,
  projectName: FolderIcon,
  environment: MonitorIcon,
  branch: GitBranchIcon,
  terminals: TerminalIcon,
  pullRequest: PullRequestGlyph.pullRequest,
  issues: IssueGlyph.issue,
  agents: BotIcon,
  spacer: MoveHorizontalIcon,
};

const VISIBLE_LINES = ["top", "middle", "bottom"] as const;
const PREVIEW_THREAD_LIMIT = 8;
const EMPTY_PROVIDER_ENTRIES = new Map();
const noop = () => {};

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
          <DialogPopup className="max-w-4xl">
            <DialogHeader>
              <DialogTitle>
                <T>Sidebar thread rows</T>
              </DialogTitle>
              <DialogDescription>
                <T>
                  Drag items on the card to rearrange them, or click one to change it. Changes apply
                  right away.
                </T>
              </DialogDescription>
            </DialogHeader>
            <DialogPanel>
              <SidebarRowLayoutEditor />
            </DialogPanel>
            <DialogFooter variant="bare">
              <Button type="button" variant="ghost" disabled={isDefault} onClick={reset}>
                <T>Reset to default</T>
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

function SidebarRowLayoutEditor() {
  const saved = resolveSidebarRowLayout(useClientSettings((settings) => settings.sidebarRowLayout));
  const threads = usePreviewThreads();
  const [chosenThreadKey, setChosenThreadKey] = useState<string | null>(null);
  const editThread =
    threads.find((thread) => previewThreadKey(thread) === chosenThreadKey) ??
    threads.find((thread) => thread.branch) ??
    threads[0] ??
    null;
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  // Nothing moves while dragging: an insertion mark shows the drop spot, and the layout changes once
  // on drop. Positions are measured when the drag starts so the mark cannot shift its own target.
  const [drag, setDrag] = useState<{ key: string; target: DropTarget | null } | null>(null);
  const geometryRef = useRef<DragGeometry | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const lastFocusedRef = useRef<Element | null>(null);
  // Moving or hiding an item swaps its element, and Hide removes its own button. Without this,
  // workspace focus recovery hands focus to an older control and scrolls the page to it.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Keeps DOM focus inside the editor after a commit removes the focused element, before workspace focus recovery runs on the next frame.
  useLayoutEffect(() => {
    const root = rootRef.current;
    const lastFocused = lastFocusedRef.current;
    if (
      !root ||
      !lastFocused ||
      lastFocused.isConnected ||
      document.activeElement !== document.body
    ) {
      return;
    }
    const selectedElement =
      selectedKey === null
        ? null
        : root.querySelector<HTMLElement>(`[data-layout-key="${CSS.escape(selectedKey)}"]`);
    (selectedElement ?? root).focus({ preventScroll: true });
  });
  const layout = saved;
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  const handleDragStart = ({ active, activatorEvent }: DragStartEvent) => {
    const key = String(active.id);
    geometryRef.current = rootRef.current ? measureGeometry(rootRef.current, activatorEvent) : null;
    setSelectedKey(key);
    setDrag({ key, target: null });
  };
  const handleDragMove = ({ active, delta }: DragMoveEvent) => {
    const geometry = geometryRef.current;
    if (!geometry) return;
    const key = String(active.id);
    const tokenId = findSidebarRowToken(layout, key)?.token.id;
    const target = dropTargetAt(geometry, key, tokenId, {
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
  const handleDragEnd = () => {
    const target = drag?.target;
    if (drag && target) {
      saveLayout(moveSidebarRowToken(layout, drag.key, target.line, target.index));
      if (target.line === "hidden" && drag.key.startsWith("spacer")) setSelectedKey(null);
    }
    geometryRef.current = null;
    setDrag(null);
  };

  const selected = selectedKey === null ? null : findSidebarRowToken(layout, selectedKey);
  const insertAt = (line: SidebarRowLine) =>
    drag?.target?.line === line ? drag.target.index : null;
  const editing = {
    renderLine: (
      line: (typeof VISIBLE_LINES)[number],
      items: ReadonlyArray<SidebarRowLayoutItem>,
    ) => (
      <EditableLine
        line={line}
        items={items}
        selectedKey={selected?.token.key ?? null}
        draggingKey={drag?.key ?? null}
        insertAt={insertAt(line)}
        onSelect={setSelectedKey}
      />
    ),
  };
  const draggedToken = drag ? findSidebarRowToken(layout, drag.key)?.token : undefined;

  return (
    <DndContext
      sensors={sensors}
      // Scrolling mid-drag would move everything away from the measured positions.
      autoScroll={false}
      onDragStart={handleDragStart}
      onDragMove={handleDragMove}
      onDragEnd={handleDragEnd}
      onDragCancel={() => {
        geometryRef.current = null;
        setDrag(null);
      }}
    >
      <div
        ref={rootRef}
        tabIndex={-1}
        className="grid gap-5 outline-none md:grid-cols-[16rem_minmax(0,1fr)]"
        // React sees no blur from an element that was removed, so the effect checks this instead.
        onFocus={(event) => {
          lastFocusedRef.current = event.target;
        }}
        onBlur={(event) => {
          if (event.relatedTarget !== null) lastFocusedRef.current = null;
        }}
      >
        <PreviewSidebar
          threads={threads}
          layout={layout}
          editingThreadKey={editThread ? previewThreadKey(editThread) : null}
          onPick={setChosenThreadKey}
        />
        <div className="flex min-w-0 flex-col gap-4">
          {editThread ? (
            <SidebarRowLayoutEditingContext value={editing}>
              <div
                data-layout-card
                // Enlarged so items are easy to grab; the preview sidebar shows the real size.
                className="w-80 max-w-full rounded-lg border border-sidebar-border/70 bg-sidebar p-2 text-sidebar-foreground md:[zoom:1.4]"
              >
                <ul role="presentation" className="flex flex-col">
                  <PreviewRow thread={editThread} layout={layout} active={false} onPick={noop} />
                </ul>
              </div>
            </SidebarRowLayoutEditingContext>
          ) : (
            <p className="text-muted-foreground text-xs">
              <T>Start a thread to preview its sidebar row here.</T>
            </p>
          )}
          <ItemInspector layout={layout} selected={selected} onSelect={setSelectedKey} />
          <HiddenTray
            layout={layout}
            selectedKey={selected?.token.key ?? null}
            draggingKey={drag?.key ?? null}
            dropping={drag?.target?.line === "hidden"}
            onSelect={setSelectedKey}
            onAddSpacer={() => {
              const inserted =
                selected && selected.line !== "hidden"
                  ? insertSidebarRowSpacer(layout, selected.line, selected.index + 1)
                  : insertSidebarRowSpacer(layout, "bottom", Number.POSITIVE_INFINITY);
              saveLayout(inserted.layout);
              setSelectedKey(inserted.key);
            }}
          />
        </div>
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

type PreviewThread = ReturnType<typeof useThreadShells>[number];

const previewThreadKey = (thread: PreviewThread) => `${thread.environmentId}:${thread.id}`;

function usePreviewThreads() {
  return useThreadShells()
    .filter((thread) => thread.archivedAt === null)
    .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, PREVIEW_THREAD_LIMIT);
}

/** A few recent threads at the sidebar's real size, with the environment count switchable. */
function PreviewSidebar(props: {
  threads: ReadonlyArray<PreviewThread>;
  layout: SidebarRowLayout;
  editingThreadKey: string | null;
  onPick: (key: string) => void;
}) {
  const gt = useGT();
  const spansEnvironments = projectGroupsSpanEnvironments(useSidebarProjectGroups());
  const [multiple, setMultiple] = useState<boolean | null>(null);
  const showsEnvironments = multiple ?? spansEnvironments;
  // The sidebar hides Environment when every thread runs on one environment.
  const layout = showsEnvironments
    ? props.layout
    : withoutSidebarRowItem(props.layout, "environment");
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <span role="group" aria-label={gt("Environments")} className="flex items-center gap-0.5">
        {[false, true].map((value) => (
          <Button
            key={String(value)}
            type="button"
            size="xs"
            variant={showsEnvironments === value ? "secondary" : "ghost-muted"}
            aria-pressed={showsEnvironments === value}
            onClick={() => setMultiple(value)}
          >
            {value ? gt("Multiple environments") : gt("One environment")}
          </Button>
        ))}
      </span>
      <div className="max-h-[28rem] overflow-y-auto rounded-lg border border-sidebar-border/70 bg-sidebar p-2 text-sidebar-foreground">
        <ul role="presentation" className="flex flex-col">
          {props.threads.map((thread) => (
            <PreviewRow
              key={previewThreadKey(thread)}
              thread={thread}
              layout={layout}
              active={previewThreadKey(thread) === props.editingThreadKey}
              onPick={props.onPick}
            />
          ))}
        </ul>
      </div>
      <p className="text-muted-foreground text-xs">
        <T>Click a thread to edit its card.</T>
      </p>
    </div>
  );
}

/** A real thread, rendered by the sidebar's own row. */
function PreviewRow(props: {
  thread: PreviewThread;
  layout: SidebarRowLayout;
  active: boolean;
  onPick: (key: string) => void;
}) {
  const { thread } = props;
  const projects = useProjects();
  const projectGroups = useSidebarProjectGroups();
  const environments = useEnvironmentIdentities();
  const machines = useEnvironmentMachines();
  const providerEntries = useAtomValue(sidebarProviderEntriesAtom);
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const projectKey = `${thread.environmentId}:${thread.projectId}`;
  const pick = () => props.onPick(previewThreadKey(thread));
  return (
    <SidebarThreadRow
      thread={thread}
      variant="card"
      layout={props.layout}
      variantAction="settle"
      settlementSupported={false}
      snoozeSupported={false}
      pinningSupported={false}
      isPinned={thread.pinnedAt != null}
      dropVerb={null}
      dragOverPinned={false}
      sweepAction={null}
      snoozeWakeLabelText={null}
      wokeAt={null}
      isActive={props.active}
      isRouteThread={false}
      readOpensPullRequestsInRightPanel={() => false}
      jumpLabel={null}
      environmentLabel={
        environments.find((environment) => environment.environmentId === thread.environmentId)
          ?.label ?? null
      }
      environmentMachine={machines.get(thread.environmentId) ?? "server"}
      project={
        projects.find((candidate) => `${candidate.environmentId}:${candidate.id}` === projectKey) ??
        null
      }
      projectDisplayName={
        projectGroups.find((group) =>
          group.memberProjects.some(
            (member) => `${member.environmentId}:${member.id}` === projectKey,
          ),
        )?.displayName ?? null
      }
      providerEntryByInstanceId={
        providerEntries.get(thread.environmentId) ?? EMPTY_PROVIDER_ENTRIES
      }
      timestampFormat={timestampFormat}
      onThreadClick={pick}
      onThreadActivate={pick}
      onStartRename={noop}
      onRenameTitleChange={noop}
      onCommitRename={noop}
      onCancelRename={noop}
      isRenaming={false}
      renamingTitle=""
      onContextMenu={noop}
      onSettle={noop}
      onActionSweepStart={noop}
      onUnsettle={noop}
      onSnooze={noop}
      onUnsnooze={noop}
      onUnpin={noop}
      onAcknowledgeWoke={noop}
    />
  );
}

function EditableLine(props: {
  line: (typeof VISIBLE_LINES)[number];
  items: ReadonlyArray<SidebarRowLayoutItem>;
  selectedKey: string | null;
  draggingKey: string | null;
  insertAt: number | null;
  onSelect: (key: string) => void;
}) {
  const gt = useGT();
  const label = {
    top: gt("Top line"),
    middle: gt("Middle line"),
    bottom: gt("Bottom line"),
  }[props.line];
  // The insertion index skips the dragged item, matching how a move removes it first.
  const nodes: ReactNode[] = [];
  let position = 0;
  const marker = <span key="insert" aria-hidden className={INSERTION_MARK_CLASS_NAME} />;
  for (const item of props.items) {
    if (props.insertAt === position && item.token.key !== props.draggingKey) nodes.push(marker);
    if (item.token.key !== props.draggingKey) position++;
    nodes.push(
      <EditableItem
        key={item.token.key}
        token={item.token}
        node={item.node}
        line={props.line}
        selected={item.token.key === props.selectedKey}
        dragging={item.token.key === props.draggingKey}
        onSelect={props.onSelect}
        // Mirrors the row: the title fills its line unless a spacer there does.
        stretches={
          item.token.id === "spacer" ||
          (item.token.id === "title" && !props.items.some((other) => other.token.id === "spacer"))
        }
      />,
    );
  }
  if (props.insertAt !== null && props.insertAt >= position) nodes.push(marker);
  return (
    <span
      data-layout-line={props.line}
      role="group"
      aria-label={label}
      className={cn(
        "flex min-h-5 min-w-0 flex-1 items-center gap-2 rounded-sm outline-1 outline-dashed outline-muted-foreground/25",
        props.insertAt !== null && "bg-accent/30 outline-ring/60",
      )}
    >
      {nodes}
    </span>
  );
}

function EditableItem(props: {
  token: SidebarRowToken;
  node: ReactNode;
  line: SidebarRowLine;
  selected: boolean;
  dragging: boolean;
  onSelect: (key: string) => void;
  stretches: boolean;
}) {
  const label = useItemLabel();
  const { attributes, listeners, setNodeRef } = useDraggable({ id: props.token.key });
  const Icon = ITEM_ICONS[props.token.id];
  const isSpacer = props.token.id === "spacer";
  const select = () => props.onSelect(props.token.key);
  return (
    <span
      ref={setNodeRef}
      {...attributes}
      data-layout-key={props.token.key}
      data-layout-item-line={props.line}
      aria-label={label(props.token.id)}
      aria-pressed={props.selected}
      // Capture, so badges that stop pointer events still start a drag.
      onPointerDownCapture={(event) => {
        (listeners?.onPointerDown as ((event: unknown) => void) | undefined)?.(event);
      }}
      onClick={(event) => {
        event.stopPropagation();
        select();
      }}
      onKeyDown={(event: KeyboardEvent) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        event.stopPropagation();
        select();
      }}
      className={cn(
        "relative inline-flex min-w-0 cursor-grab touch-none items-center rounded-sm outline-1 active:cursor-grabbing",
        props.stretches ? "flex-1" : "shrink",
        isSpacer && "min-w-4 self-stretch",
        props.selected
          ? "outline-ring outline-solid"
          : "outline-transparent outline-dashed hover:outline-ring/60",
        props.dragging && "opacity-40",
      )}
    >
      {isSpacer ? (
        <span className="flex h-full w-full items-center justify-center rounded-sm border border-dashed border-muted-foreground/35">
          <MoveHorizontalIcon aria-hidden className="size-3 text-muted-foreground/60" />
        </span>
      ) : props.node === null ? (
        // Kept visible so items this thread has nothing for can still be arranged.
        <span className="inline-flex size-4 shrink-0 items-center justify-center rounded-sm border border-dashed border-muted-foreground/35 text-muted-foreground/60">
          <Icon aria-hidden className="size-2.5" />
        </span>
      ) : (
        <span inert className="contents">
          {props.node}
        </span>
      )}
    </span>
  );
}

function ItemInspector(props: {
  layout: SidebarRowLayout;
  selected: ReturnType<typeof findSidebarRowToken>;
  onSelect: (key: string | null) => void;
}) {
  const gt = useGT();
  const label = useItemLabel();
  const { selected } = props;
  if (selected === null) {
    return (
      <p className="text-muted-foreground text-xs">
        <T>Click an item to move it, change its form, or hide it.</T>
      </p>
    );
  }
  const { token, line, index } = selected;
  const Icon = ITEM_ICONS[token.id];
  const forms = SIDEBAR_ROW_ITEM_FORMS[token.id];
  const lineLength = props.layout[line].length;
  const move = (to: SidebarRowLine, at: number) =>
    saveLayout(moveSidebarRowToken(props.layout, token.key, to, at));
  const lineLabels = {
    top: gt("Top", { $context: "sidebar row line" }),
    middle: gt("Middle", { $context: "sidebar row line" }),
    bottom: gt("Bottom", { $context: "sidebar row line" }),
  };
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-xs">
      <span className="inline-flex items-center gap-1.5 font-medium">
        <Icon aria-hidden className="size-3.5 text-icon-muted" />
        {label(token.id)}
      </span>
      <span role="group" aria-label={gt("Line")} className="inline-flex items-center gap-0.5">
        {VISIBLE_LINES.map((target) => (
          <Button
            key={target}
            type="button"
            size="xs"
            variant={line === target ? "secondary" : "ghost-muted"}
            aria-pressed={line === target}
            onClick={() => move(target, Number.POSITIVE_INFINITY)}
          >
            {lineLabels[target]}
          </Button>
        ))}
      </span>
      {line === "hidden" ? null : (
        <span className="inline-flex items-center gap-0.5">
          <Button
            type="button"
            size="icon-xs"
            variant="ghost-muted"
            disabled={index === 0}
            aria-label={gt("Move earlier")}
            onClick={() => move(line, index - 1)}
          >
            <ArrowLeftIcon />
          </Button>
          <Button
            type="button"
            size="icon-xs"
            variant="ghost-muted"
            disabled={index === lineLength - 1}
            aria-label={gt("Move later")}
            onClick={() => move(line, index + 1)}
          >
            <ArrowRightIcon />
          </Button>
        </span>
      )}
      {forms ? (
        <span role="group" aria-label={gt("Form")} className="inline-flex items-center gap-0.5">
          {forms.map((form) => (
            <Button
              key={form}
              type="button"
              size="xs"
              variant={token.form === form ? "secondary" : "ghost-muted"}
              aria-pressed={token.form === form}
              onClick={() => saveLayout(setSidebarRowTokenForm(props.layout, token.key, form))}
            >
              {form === "wide"
                ? gt("Wide", { $context: "icon and name" })
                : gt("Compact", { $context: "icon only" })}
            </Button>
          ))}
        </span>
      ) : null}
      {line === "hidden" || token.id === "title" ? null : (
        <Button
          type="button"
          size="xs"
          variant="ghost-muted"
          onClick={() => {
            move("hidden", Number.POSITIVE_INFINITY);
            if (token.id === "spacer") props.onSelect(null);
          }}
        >
          {token.id === "spacer" ? gt("Remove") : gt("Hide")}
        </Button>
      )}
    </div>
  );
}

function HiddenTray(props: {
  layout: SidebarRowLayout;
  selectedKey: string | null;
  draggingKey: string | null;
  dropping: boolean;
  onSelect: (key: string) => void;
  onAddSpacer: () => void;
}) {
  const gt = useGT();
  const hidden = props.layout.hidden;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-muted-foreground text-xs">
          <T>Hidden</T>
        </span>
        <Button type="button" size="xs" variant="ghost-muted" onClick={props.onAddSpacer}>
          <PlusIcon aria-hidden />
          <T>Add spacer</T>
        </Button>
      </div>
      <div
        data-layout-tray
        role="group"
        aria-label={gt("Hidden items")}
        className={cn(
          "flex min-h-9 flex-wrap items-center gap-1 rounded-md border border-dashed border-border p-1",
          props.dropping && "border-ring bg-accent/40",
        )}
      >
        {hidden.map((token) => (
          <HiddenChip
            key={token.key}
            token={token}
            selected={token.key === props.selectedKey}
            dragging={token.key === props.draggingKey}
            onSelect={props.onSelect}
          />
        ))}
        {hidden.length === 0 ? (
          <span className="px-1 text-muted-foreground text-xs">
            <T>Drag items here to hide them, or spacers to remove them.</T>
          </span>
        ) : null}
      </div>
    </div>
  );
}

function HiddenChip(props: {
  token: SidebarRowToken;
  selected: boolean;
  dragging: boolean;
  onSelect: (key: string) => void;
}) {
  const { attributes, listeners, setNodeRef } = useDraggable({ id: props.token.key });
  return (
    <span
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      data-layout-key={props.token.key}
      data-layout-item-line="hidden"
      aria-pressed={props.selected}
      onClick={() => props.onSelect(props.token.key)}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        props.onSelect(props.token.key);
      }}
      className={cn(
        "cursor-grab touch-none active:cursor-grabbing",
        props.dragging && "opacity-40",
      )}
    >
      <ItemChip token={props.token} selected={props.selected} />
    </span>
  );
}

function ItemChip(props: { token: SidebarRowToken; selected?: boolean; lifted?: boolean }) {
  const label = useItemLabel();
  const Icon = ITEM_ICONS[props.token.id];
  return (
    <span
      className={cn(
        "inline-flex h-6 items-center gap-1 rounded-md border bg-background px-1.5 text-muted-foreground text-xs",
        props.selected ? "border-ring text-foreground" : "border-border",
        props.lifted && "text-foreground shadow-md",
      )}
    >
      <Icon aria-hidden className="size-3.5 shrink-0" />
      {label(props.token.id)}
    </span>
  );
}

const INSERTION_MARK_CLASS_NAME =
  // Negative margins cancel the line's gap, so the mark does not push items aside.
  "-mx-[5px] h-4 w-0.5 shrink-0 rounded-full bg-primary";

type DropTarget = { line: SidebarRowLine; index: number };

interface DragGeometry {
  origin: { x: number; y: number };
  card: DOMRect | null;
  tray: DOMRect | null;
  lines: ReadonlyArray<{ line: SidebarRowLine; rect: DOMRect }>;
  items: ReadonlyArray<{ key: string; line: SidebarRowLine; rect: DOMRect }>;
}

function measureGeometry(root: HTMLElement, activatorEvent: Event): DragGeometry {
  const pointer = activatorEvent as PointerEvent;
  return {
    origin: { x: pointer.clientX, y: pointer.clientY },
    card: root.querySelector("[data-layout-card]")?.getBoundingClientRect() ?? null,
    tray: root.querySelector("[data-layout-tray]")?.getBoundingClientRect() ?? null,
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

const contains = (rect: DOMRect, point: { x: number; y: number }, slop = 0) =>
  point.x >= rect.left - slop &&
  point.x <= rect.right + slop &&
  point.y >= rect.top - slop &&
  point.y <= rect.bottom + slop;

/** The line under the pointer, and how many of its other items sit left of the pointer. */
function dropTargetAt(
  geometry: DragGeometry,
  key: string,
  tokenId: SidebarRowItemId | undefined,
  point: { x: number; y: number },
): DropTarget | null {
  if (geometry.tray && contains(geometry.tray, point)) {
    return tokenId === "title" ? null : { line: "hidden", index: Number.POSITIVE_INFINITY };
  }
  if (!geometry.card || !contains(geometry.card, point, 16)) return null;
  let nearest: { line: SidebarRowLine; distance: number } | null = null;
  for (const { line, rect } of geometry.lines) {
    const distance = point.y < rect.top ? rect.top - point.y : Math.max(0, point.y - rect.bottom);
    if (nearest === null || distance < nearest.distance) nearest = { line, distance };
  }
  if (nearest === null) return null;
  const line = nearest.line;
  const index = geometry.items.filter(
    (item) =>
      item.line === line && item.key !== key && item.rect.left + item.rect.width / 2 < point.x,
  ).length;
  return { line, index };
}
