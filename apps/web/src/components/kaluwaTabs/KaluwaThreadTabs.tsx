// Fork: Kaluwa's titlebar tabs. With tabs on, the chat titlebar shows one tab per open thread or
// new-thread draft instead of the thread breadcrumb; with them off it is upstream's ChatHeader.
// Tabs pin, group, reorder by drag and close in batches like a browser's. Styles live in the
// "Kaluwa titlebar tabs" block of index.css.
import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";
import { useGT } from "gt-react";
import { providerInstanceInitials } from "@t3tools/client-runtime/state/provider-instance-display";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { FolderIcon, PlusIcon, XIcon } from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type WheelEvent as ReactWheelEvent,
} from "react";

import { useComposerDraftStore } from "../../composerDraftStore";
import { contextMenuSourceOf } from "../../contextMenuSource";
import { useThreadActionMenu } from "../../hooks/useThreadActionMenu";
import { useThreadRouteTarget } from "../../hooks/useThreadRouteTarget";
import { shortcutLabelForCommand } from "../../keybindings";
import {
  type ThreadTabGroup,
  type ThreadTabKey,
  type ThreadTabsState,
  dropThreadTab,
  moveThreadTabGroup,
  parseThreadTabKey,
} from "../../kaluwa/kaluwaThreadTabs.logic";
import {
  kaluwaTabsStyleVariables,
  useKaluwaTabsSettings,
  type KaluwaTabsSettings,
} from "../../kaluwa/kaluwaTabsSettings";
import { observeResize } from "../../lib/observeResize";
import { cn } from "../../lib/utils";
import { useProjects, useQuietThreadShells, useThreadShell } from "../../state/entities";
import {
  useEnvironmentMachines,
  useEnvironments,
  usePrimaryEnvironmentId,
} from "../../state/environments";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { readEnvironmentScope } from "../../state/session";
import { threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { textDirection } from "../../textDirection";
import { useUiStateStore } from "../../uiStateStore";
import { ChatHeader } from "../chat/ChatHeader";
import { GuestShareIndicator } from "../chat/GuestShareControls";
import { canShareWithGuestAtom } from "../chat/guestShareAvailability";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import {
  hasUnseenCompletion,
  resolveSidebarRowStatus,
  resolveThreadLastVisitedAt,
} from "../Sidebar.logic";
import type { KaluwaThreadAvatar } from "../sidebar/KaluwaThreadAvatar";
import { ProjectFavicon } from "../ProjectFavicon";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { getTriggerDisplayModelName } from "../chat/providerIconUtils";
import { kaluwaInstanceAccent } from "../../kaluwa/kaluwaAccent";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  showThreadTabGroupMenu,
  showThreadTabMenu,
  type ThreadTabMenuContext,
} from "./threadTabMenus";
import {
  activateThreadTab,
  closeThreadTabsAndFollow,
  openNewThreadTab,
  registerThreadTabStrip,
  syncThreadTabRoute,
  threadTabKeyForRouteTarget,
  threadTabProjectKey,
  updateThreadTabs,
  useLiveThreadTabs,
} from "./threadTabActions";
import { useThreadTabProvider } from "./threadTabProvider";

type ChatHeaderProps = ComponentProps<typeof ChatHeader>;

/** Upstream's ChatHeader, or the tab strip in its place while Kaluwa's tabs are on. */
export function KaluwaChatHeader(props: ChatHeaderProps) {
  const settings = useKaluwaTabsSettings();
  return settings.enabled ? (
    <KaluwaThreadTabStrip header={props} settings={settings} />
  ) : (
    <ChatHeader {...props} />
  );
}

const DRAG_THRESHOLD_PX = 5;
const AUTO_SCROLL_EDGE_PX = 36;
const AUTO_SCROLL_STEP_PX = 12;

/** One thing that moves as a block while dragging: a tab, or a group's chip with its tabs. */
type DragUnit = {
  readonly elements: ReadonlyArray<HTMLElement>;
  readonly first: ThreadTabKey | null;
  readonly last: ThreadTabKey | null;
  readonly left: number;
  readonly right: number;
};

type TabDrag = {
  readonly subject:
    | { readonly kind: "tab"; readonly key: ThreadTabKey }
    | {
        readonly kind: "group";
        readonly id: string;
      };
  readonly pointerId: number;
  readonly startX: number;
  readonly element: HTMLElement;
  readonly list: HTMLElement;
  startScroll: number;
  units: ReadonlyArray<DragUnit>;
  from: number;
  to: number;
  dragging: boolean;
};

type Renaming =
  | { readonly kind: "thread"; readonly key: ThreadTabKey }
  | { readonly kind: "group"; readonly id: string }
  | null;

/**
 * The drag units, in content coordinates: every tab for a tab drag; each group's frame and each
 * ungrouped unpinned tab for a group drag.
 */
function measureDragUnits(list: HTMLElement, groupDrag: boolean): DragUnit[] {
  const listLeft = list.getBoundingClientRect().left - list.scrollLeft;
  const units: Array<{ elements: HTMLElement[]; first: string | null; last: string | null }> = [];
  if (!groupDrag) {
    for (const tab of list.querySelectorAll<HTMLElement>("[data-kaluwa-tab-key]")) {
      const key = tab.dataset.kaluwaTabKey!;
      units.push({ elements: [tab], first: key, last: key });
    }
  } else {
    for (const child of list.children) {
      if (!(child instanceof HTMLElement) || child.dataset.pinned !== undefined) continue;
      const keys = [
        ...(child.dataset.kaluwaTabKey !== undefined ? [child] : []),
        ...child.querySelectorAll<HTMLElement>("[data-kaluwa-tab-key]"),
      ].map((tab) => tab.dataset.kaluwaTabKey!);
      if (child.dataset.kaluwaGroupFrame === undefined && keys.length === 0) continue;
      units.push({ elements: [child], first: keys[0] ?? null, last: keys.at(-1) ?? null });
    }
  }
  return units.map((unit) => {
    const rects = unit.elements.map((element) => element.getBoundingClientRect());
    return {
      ...unit,
      left: Math.min(...rects.map((rect) => rect.left)) - listLeft,
      right: Math.max(...rects.map((rect) => rect.right)) - listLeft,
    };
  });
}

function KaluwaThreadTabStrip({
  header,
  settings,
}: {
  readonly header: ChatHeaderProps;
  readonly settings: KaluwaTabsSettings;
}) {
  const gt = useGT();
  const router = useRouter();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const live = useLiveThreadTabs();
  const routeKey = threadTabKeyForRouteTarget(useThreadRouteTarget());
  // Before the route lands in the list (first launch, or the last tab just closed) show it alone.
  const state: ThreadTabsState =
    live.tabs.length === 0 && routeKey !== null ? { ...live, tabs: [routeKey] } : live;
  const activeKey = routeKey !== null && state.tabs.includes(routeKey) ? routeKey : live.active;
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const machines = useEnvironmentMachines();
  const { environments } = useEnvironments();
  const projects = useProjects();
  const shells = useQuietThreadShells();
  const draftThreadsByThreadKey = useComposerDraftStore((store) => store.draftThreadsByThreadKey);
  const dragRef = useRef<TabDrag | null>(null);
  const suppressClickRef = useRef(false);
  const [renaming, setRenaming] = useState<Renaming>(null);
  const updateThreadMetadata = useOrchestrationCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the saved tab list follows the router's thread, opening or activating a tab
  useEffect(() => {
    if (routeKey !== null) syncThreadTabRoute(router);
  }, [routeKey, router]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers the tab shortcuts with the keyboard dispatcher and a document middle-click listener
  useEffect(() => registerThreadTabStrip(router), [router]);

  const activeThreadRef = scopeThreadRef(header.activeThreadEnvironmentId, header.activeThreadId);
  const canShareWithGuest = useAtomValue(canShareWithGuestAtom(header.activeThreadEnvironmentId));
  const { openMenu: openThreadActions } = useThreadActionMenu({
    threadRef: header.isServerThread ? activeThreadRef : null,
    projectCwd: header.activeProject?.workspaceRoot ?? null,
    onStartRename: () => {
      if (activeKey !== null) setRenaming({ kind: "thread", key: activeKey });
    },
    onFind: header.onFindInThread,
    canShareWithGuest,
  });

  const shortcutOptions = { context: { kaluwaTabs: true } };
  const newTabShortcut = shortcutLabelForCommand(keybindings, "threadTab.new", shortcutOptions);
  const closeTabShortcut = shortcutLabelForCommand(keybindings, "threadTab.close", shortcutOptions);

  const environmentLabel = (environmentId: EnvironmentId) =>
    environments.find((environment) => environment.environmentId === environmentId)?.label ?? null;

  const menuContext: ThreadTabMenuContext = {
    router,
    startRename: setRenaming,
    projectName: (project) =>
      projects.find(
        (candidate) => threadTabProjectKey(candidate.environmentId, candidate.id) === project,
      )?.title ?? null,
  };

  const handleTabContextMenu = (event: ReactMouseEvent, key: ThreadTabKey) => {
    event.preventDefault();
    const target = parseThreadTabKey(key);
    const canRename =
      target?.kind === "thread" &&
      readEnvironmentScope(target.ref.environmentId, AuthOrchestrationOperateScope);
    const position = { x: event.clientX, y: event.clientY };
    const source = contextMenuSourceOf(event);
    void showThreadTabMenu(menuContext, key, { canRename, position, source }).then((action) => {
      if (action === "thread-actions" && key === activeKey && header.isServerThread) {
        openThreadActions(position, source);
      }
    });
  };

  const handleGroupContextMenu = (event: ReactMouseEvent, group: ThreadTabGroup) => {
    event.preventDefault();
    void showThreadTabGroupMenu(menuContext, group, {
      position: { x: event.clientX, y: event.clientY },
      source: contextMenuSourceOf(event),
    });
  };

  const commitThreadRename = (key: ThreadTabKey, title: string, original: string) => {
    setRenaming(null);
    const target = parseThreadTabKey(key);
    const trimmed = title.trim();
    if (target?.kind !== "thread" || trimmed === original) return;
    if (!readEnvironmentScope(target.ref.environmentId, AuthOrchestrationOperateScope)) return;
    if (trimmed.length === 0) {
      toastManager.add({ type: "warning", title: gt("Thread title cannot be empty") });
      return;
    }
    void updateThreadMetadata({
      environmentId: target.ref.environmentId,
      input: { threadId: target.ref.threadId, title: trimmed },
    }).then((result) => {
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        toastManager.add({ type: "error", title: gt("Failed to rename thread") });
      }
    });
  };

  const commitGroupRename = (id: string, name: string) => {
    setRenaming(null);
    updateThreadTabs((current) => ({
      ...current,
      groups: current.groups.map((group) =>
        group.id === id ? { ...group, name: name.trim().slice(0, 40) } : group,
      ),
    }));
  };

  const endDrag = (event: ReactPointerEvent) => {
    const drag = dragRef.current;
    if (drag === null || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (!drag.dragging) return;
    suppressClickRef.current = true;
    for (const unit of drag.units) {
      for (const element of unit.elements) {
        element.style.transform = "";
        element.style.transition = "";
        delete element.dataset.dragging;
      }
    }
    if (drag.to === drag.from) return;
    const target = drag.units[drag.to];
    const side = drag.to > drag.from ? "after" : "before";
    const targetKey = side === "after" ? target?.last : target?.first;
    if (targetKey === null || targetKey === undefined) return;
    const { subject } = drag;
    updateThreadTabs((current) =>
      subject.kind === "tab"
        ? dropThreadTab(current, subject.key, targetKey, side)
        : moveThreadTabGroup(current, subject.id, targetKey, side),
    );
  };

  const startDrag = (event: ReactPointerEvent<HTMLElement>, subject: TabDrag["subject"]) => {
    if (event.button !== 0 || !event.isPrimary || renaming !== null) return;
    if ((event.target as HTMLElement).closest("button:not([data-kaluwa-group-dot]), input")) {
      return;
    }
    const list = event.currentTarget.closest<HTMLElement>(".kaluwa-tabs-list");
    if (list === null) return;
    suppressClickRef.current = false;
    dragRef.current = {
      subject,
      pointerId: event.pointerId,
      startX: event.clientX,
      element: event.currentTarget,
      list,
      startScroll: list.scrollLeft,
      units: [],
      from: -1,
      to: -1,
      dragging: false,
    };
  };

  // Only `transform` changes while dragging; the order is saved once on release.
  const handlePointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (drag === null || drag.pointerId !== event.pointerId) return;
    const pointerDx = event.clientX - drag.startX;
    if (!drag.dragging) {
      if (Math.abs(pointerDx) < DRAG_THRESHOLD_PX) return;
      drag.units = measureDragUnits(drag.list, drag.subject.kind === "group");
      drag.startScroll = drag.list.scrollLeft;
      drag.from = drag.units.findIndex((unit) =>
        unit.elements.some((element) => element.contains(drag.element)),
      );
      if (drag.from === -1) {
        dragRef.current = null;
        return;
      }
      drag.to = drag.from;
      drag.dragging = true;
      drag.element.setPointerCapture(event.pointerId);
      for (const element of drag.units[drag.from]!.elements) element.dataset.dragging = "";
    }
    const listRect = drag.list.getBoundingClientRect();
    if (event.clientX < listRect.left + AUTO_SCROLL_EDGE_PX) {
      drag.list.scrollLeft -= AUTO_SCROLL_STEP_PX;
    } else if (event.clientX > listRect.right - AUTO_SCROLL_EDGE_PX) {
      drag.list.scrollLeft += AUTO_SCROLL_STEP_PX;
    }
    const dx = pointerDx + drag.list.scrollLeft - drag.startScroll;
    const own = drag.units[drag.from]!;
    const center = (own.left + own.right) / 2 + dx;
    let to = drag.from;
    drag.units.forEach((unit, index) => {
      const middle = (unit.left + unit.right) / 2;
      if (index > drag.from && center > middle) to = Math.max(to, index);
      if (index < drag.from && center < middle) to = Math.min(to, index);
    });
    drag.to = to;
    const next = drag.units[drag.from + 1];
    const previous = drag.units[drag.from - 1];
    const gap = next ? next.left - own.right : previous ? own.left - previous.right : 0;
    const step = own.right - own.left + gap;
    drag.units.forEach((unit, index) => {
      const shift =
        index === drag.from
          ? dx
          : index > drag.from && index <= to
            ? -step
            : index < drag.from && index >= to
              ? step
              : 0;
      for (const element of unit.elements) {
        element.style.transition = index === drag.from ? "none" : "transform 150ms ease-out";
        element.style.transform = shift === 0 ? "" : `translateX(${shift}px)`;
      }
    });
  };

  const consumeDragClick = () => {
    if (!suppressClickRef.current) return false;
    suppressClickRef.current = false;
    return true;
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLElement>, key: ThreadTabKey) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      activateThreadTab(router, key);
      return;
    }
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const list = event.currentTarget.closest(".kaluwa-tabs-list");
    const tabs = list ? [...list.querySelectorAll<HTMLElement>('[role="tab"]')] : [];
    const index = tabs.indexOf(event.currentTarget);
    tabs[index + (event.key === "ArrowLeft" ? -1 : 1)]?.focus();
  };

  const handleWheel = (event: ReactWheelEvent<HTMLElement>) => {
    if (event.deltaX !== 0 || event.deltaY === 0) return;
    event.currentTarget.scrollLeft += event.deltaY;
  };

  const closeLabel = closeTabShortcut
    ? gt("Close tab ({shortcut})", { shortcut: closeTabShortcut })
    : gt("Close tab");
  const projectByKey = new Map(
    projects.map((project) => [threadTabProjectKey(project.environmentId, project.id), project]),
  );
  const projectFor: ProjectLookup = (environmentId, projectId) =>
    projectByKey.get(threadTabProjectKey(environmentId, projectId)) ?? null;
  const groupsById = new Map(state.groups.map((group) => [group.id, group]));
  const shellByKey = new Map(shells.map((shell) => [`${shell.environmentId}:${shell.id}`, shell]));
  const tabSummaryOf = (key: ThreadTabKey): ThreadTabSummary => {
    const target = parseThreadTabKey(key);
    if (target?.kind === "thread") {
      const shell = shellByKey.get(scopedThreadKey(target.ref));
      return {
        key,
        title: shell?.title ?? gt("Loading thread"),
        project: shell ? projectFor(shell.environmentId, shell.projectId) : null,
      };
    }
    const draft = target ? draftThreadsByThreadKey[target.draftId] : undefined;
    return {
      key,
      title: gt("New thread"),
      project: draft ? projectFor(draft.environmentId, draft.projectId) : null,
    };
  };
  const items: ReactNode[] = [];
  const renderTab = (key: ThreadTabKey, group: ThreadTabGroup | null): ReactNode => {
    const target = parseThreadTabKey(key);
    if (target === null) return null;
    const tabProps: TabProps = {
      tabKey: key,
      active: key === activeKey,
      pinned: state.pinned.includes(key),
      group,
      renaming: renaming?.kind === "thread" && renaming.key === key,
      onClick: () => {
        if (consumeDragClick()) return;
        if (key !== activeKey) activateThreadTab(router, key);
      },
      onClose: () => closeThreadTabsAndFollow(router, [key]),
      onContextMenu: (event) => handleTabContextMenu(event, key),
      onKeyDown: (event) => handleKeyDown(event, key),
      onPointerDown: (event) => startDrag(event, { kind: "tab", key }),
      onPointerMove: handlePointerMove,
      onPointerUp: endDrag,
      onPointerCancel: endDrag,
      onCommitRename: (title, original) => commitThreadRename(key, title, original),
      onCancelRename: () => setRenaming(null),
      closeLabel,
      primaryEnvironmentId,
      machineOf: (environmentId) => machines.get(environmentId) ?? "server",
      environmentLabel,
      projectFor,
    };
    return target.kind === "thread" ? (
      <ServerThreadTab key={key} threadRef={target.ref} {...tabProps} />
    ) : (
      <DraftThreadTab key={key} draftId={target.draftId} {...tabProps} />
    );
  };
  const framedGroups = new Set<string>();
  for (const key of state.tabs) {
    const group = groupsById.get(state.groupOf[key] ?? "") ?? null;
    if (group === null) {
      items.push(renderTab(key, null));
      continue;
    }
    if (framedGroups.has(group.id)) continue;
    framedGroups.add(group.id);
    // Members are contiguous (the model guarantees it), so one frame holds them all.
    const members = state.tabs.filter((tab) => state.groupOf[tab] === group.id);
    const shown = group.collapsed ? members.filter((tab) => tab === activeKey) : members;
    const project = group.project === undefined ? null : (projectByKey.get(group.project) ?? null);
    items.push(
      <ThreadTabGroupFrame
        key={`group:${group.id}`}
        group={group}
        project={project}
        members={members.map((tab) => tabSummaryOf(tab))}
        shownCount={shown.length}
        renaming={renaming?.kind === "group" && renaming.id === group.id}
        onToggle={() => {
          if (consumeDragClick()) return;
          updateThreadTabs((current) => ({
            ...current,
            groups: current.groups.map((candidate) =>
              candidate.id === group.id
                ? { ...candidate, collapsed: !candidate.collapsed }
                : candidate,
            ),
          }));
        }}
        onContextMenu={(event) => handleGroupContextMenu(event, group)}
        onCommitRename={(name) => commitGroupRename(group.id, name)}
        onCancelRename={() => setRenaming(null)}
        onPointerDown={(event) => startDrag(event, { kind: "group", id: group.id })}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        {shown.map((tab) => renderTab(tab, group))}
      </ThreadTabGroupFrame>,
    );
  }

  return (
    <div
      className={cn("kaluwa-tabs", header.rightPanelOpen ? "pr-10" : "pr-24")}
      data-tab-style={settings.style}
      style={kaluwaTabsStyleVariables(settings)}
    >
      <div
        ref={observeTabListOverflow}
        role="tablist"
        aria-label={gt("Open threads")}
        className="kaluwa-tabs-list"
        onWheel={handleWheel}
      >
        {items}
      </div>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              className="kaluwa-tab-new"
              aria-label={gt("New tab")}
              onClick={() => void openNewThreadTab(router)}
            />
          }
        >
          <PlusIcon aria-hidden />
        </TooltipTrigger>
        <TooltipPopup side="bottom">
          {newTabShortcut
            ? gt("New tab ({shortcut})", { shortcut: newTabShortcut })
            : gt("New tab")}
        </TooltipPopup>
      </Tooltip>
      {header.isServerThread ? <GuestShareIndicator threadRef={activeThreadRef} /> : null}
    </div>
  );
}

/** Marks the list's scrolled-away ends, which index.css fades. Imperative, so scrolling never renders. */
function observeTabListOverflow(list: HTMLDivElement | null) {
  if (list === null) return;
  const update = () => {
    const max = list.scrollWidth - list.clientWidth;
    list.toggleAttribute("data-overflow-start", list.scrollLeft > 1);
    list.toggleAttribute("data-overflow-end", list.scrollLeft < max - 1);
  };
  update();
  const stopObserving = observeResize(list, update);
  const mutations = new MutationObserver(update);
  mutations.observe(list, { childList: true });
  list.addEventListener("scroll", update, { passive: true });
  return () => {
    stopObserving();
    mutations.disconnect();
    list.removeEventListener("scroll", update);
  };
}

type PointerHandlers = {
  readonly onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  readonly onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
  readonly onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void;
  readonly onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => void;
};

function RenameInput(props: {
  readonly initial: string;
  readonly label: string;
  readonly className: string;
  readonly onCommit: (value: string) => void;
  readonly onCancel: () => void;
}) {
  const doneRef = useRef(false);
  return (
    <input
      autoFocus
      dir="auto"
      aria-label={props.label}
      className={props.className}
      defaultValue={props.initial}
      onFocus={(event) => event.currentTarget.select()}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.nativeEvent.isComposing) return;
        if (event.key === "Enter") {
          doneRef.current = true;
          props.onCommit(event.currentTarget.value);
        } else if (event.key === "Escape") {
          event.preventDefault();
          doneRef.current = true;
          props.onCancel();
        }
      }}
      onBlur={(event) => {
        if (!doneRef.current) props.onCommit(event.currentTarget.value);
      }}
    />
  );
}

type ProjectLookup = (environmentId: string, projectId: string) => EnvironmentProject | null;

type ThreadTabSummary = {
  readonly key: ThreadTabKey;
  readonly title: string;
  readonly project: EnvironmentProject | null;
};

/**
 * A group: a dot in the group's colour, then its tabs, all inside one frame of that colour. The
 * dot collapses and expands the group, drags it, and opens its menu; collapsed, it shows a count.
 */
function ThreadTabGroupFrame(
  props: PointerHandlers & {
    readonly group: ThreadTabGroup;
    readonly project: EnvironmentProject | null;
    readonly members: ReadonlyArray<ThreadTabSummary>;
    readonly shownCount: number;
    readonly renaming: boolean;
    readonly children: ReactNode;
    readonly onToggle: () => void;
    readonly onContextMenu: (event: ReactMouseEvent) => void;
    readonly onCommitRename: (name: string) => void;
    readonly onCancelRename: () => void;
  },
) {
  const gt = useGT();
  const { group, project, members } = props;
  const name = project?.title ?? group.name;
  const label = name.length > 0 ? name : gt("Unnamed group");
  return (
    <div
      className="kaluwa-tab-group"
      role="group"
      aria-label={label}
      data-kaluwa-group-frame={group.id}
      data-kaluwa-group-color={group.color}
      data-collapsed={group.collapsed || undefined}
      style={{ "--kaluwa-group-tabs": props.shownCount } as CSSProperties}
    >
      {props.renaming ? (
        <RenameInput
          initial={group.name}
          label={gt("Group name")}
          className="kaluwa-tab-group-input"
          onCommit={props.onCommitRename}
          onCancel={props.onCancelRename}
        />
      ) : (
        <Tooltip>
          <TooltipTrigger
            delay={400}
            render={
              <button
                type="button"
                className="kaluwa-tab-group-dot"
                data-kaluwa-group-dot={group.id}
                aria-expanded={!group.collapsed}
                aria-label={
                  group.collapsed
                    ? gt("Expand group {name}", { name: label })
                    : gt("Collapse group {name}", { name: label })
                }
                onClick={props.onToggle}
                onContextMenu={props.onContextMenu}
                onPointerDown={props.onPointerDown}
                onPointerMove={props.onPointerMove}
                onPointerUp={props.onPointerUp}
                onPointerCancel={props.onPointerCancel}
              />
            }
          >
            {group.collapsed ? (
              <span className="kaluwa-tab-group-count">{members.length}</span>
            ) : null}
          </TooltipTrigger>
          <TooltipPopup side="bottom">
            <span className="kaluwa-tab-card">
              <span className="kaluwa-tab-card-row">
                {project !== null ? (
                  <ProjectFavicon
                    project={project}
                    className="kaluwa-folder-icon kaluwa-tab-card-icon"
                  />
                ) : (
                  <span className="kaluwa-tab-card-swatch" data-kaluwa-group-color={group.color} />
                )}
                <span className="kaluwa-tab-card-title">{label}</span>
                <span className="kaluwa-tab-card-meta">
                  {gt("{count, plural, one {{count} tab} other {{count} tabs}}", {
                    count: members.length,
                  })}
                </span>
              </span>
              {members.map((member) => (
                <span key={member.key} className="kaluwa-tab-card-row kaluwa-tab-card-member">
                  {member.project !== null && member.project !== project ? (
                    <ProjectFavicon
                      project={member.project}
                      className="kaluwa-folder-icon kaluwa-tab-card-icon"
                    />
                  ) : (
                    <span className="kaluwa-tab-card-bullet" />
                  )}
                  <span className="kaluwa-tab-card-member-title" dir={textDirection(member.title)}>
                    {member.title}
                  </span>
                </span>
              ))}
            </span>
          </TooltipPopup>
        </Tooltip>
      )}
      {props.children}
    </div>
  );
}

type TabProps = PointerHandlers & {
  readonly tabKey: ThreadTabKey;
  readonly active: boolean;
  readonly pinned: boolean;
  readonly group: ThreadTabGroup | null;
  readonly renaming: boolean;
  readonly onClick: () => void;
  readonly onClose: () => void;
  readonly onContextMenu: (event: ReactMouseEvent) => void;
  readonly onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => void;
  readonly onCommitRename: (title: string, original: string) => void;
  readonly onCancelRename: () => void;
  readonly closeLabel: string;
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly machineOf: (
    environmentId: EnvironmentId,
  ) => ComponentProps<typeof EnvironmentMachineIcon>["kind"];
  readonly environmentLabel: (environmentId: EnvironmentId) => string | null;
  readonly projectFor: ProjectLookup;
};

type TabAvatarStatus = ComponentProps<typeof KaluwaThreadAvatar>["status"];
type TabProvider = NonNullable<ReturnType<typeof useThreadTabProvider>>;

const PIP_STATUSES = new Set<TabAvatarStatus>(["approval", "input", "request", "failed", "done"]);

/** The project's icon, its provider as a badge on the bottom corner, and the status ring. */
function TabIdentity(props: {
  readonly project: EnvironmentProject | null;
  readonly provider: TabProvider | null;
  readonly status: TabAvatarStatus;
  readonly draft: boolean;
}) {
  const { provider, status } = props;
  return (
    <span aria-hidden className="kaluwa-av kaluwa-tab-ident" data-kaluwa-status={status ?? "idle"}>
      {status ? <span className="kaluwa-av-ring" /> : null}
      {/* Only `transform` animates, so the spinner stays on the compositor. */}
      {status === "working" ? <span className="kaluwa-av-spin" /> : null}
      {props.project !== null ? (
        <ProjectFavicon project={props.project} className="kaluwa-folder-icon kaluwa-tab-project" />
      ) : (
        <FolderIcon className="kaluwa-tab-project kaluwa-tab-project-fallback" />
      )}
      {provider !== null ? (
        <span className="kaluwa-tab-provider">
          <ProviderInstanceIcon
            driverKind={provider.entry.driverKind}
            displayName={provider.entry.displayName}
            accentColor={provider.entry.accentColor}
            acpRegistryAgentId={provider.entry.acpRegistryAgentId}
            acpRegistryIconUrl={provider.entry.acpRegistryIconUrl}
            // Fork: the owner wants the subscription's initials on every tab, not only when a
            // provider has several instances.
            showBadge
            size="compact"
            className="kaluwa-av-logo"
            iconClassName="kaluwa-av-icon"
            badgeClassName="kaluwa-av-badge"
          />
        </span>
      ) : props.draft ? (
        <span className="kaluwa-tab-provider kaluwa-tab-provider-new">
          <PlusIcon />
        </span>
      ) : null}
      {status && PIP_STATUSES.has(status) ? <span className="kaluwa-av-pip" /> : null}
    </span>
  );
}

function useStatusLabel(status: TabAvatarStatus): string | null {
  const gt = useGT();
  switch (status) {
    case "working":
      return gt("Working", { $context: "thread status" });
    case "waiting":
      return gt("Waiting", { $context: "thread status" });
    case "approval":
      return gt("Approval", { $context: "thread status: needs approval" });
    case "input":
      return gt("Input", { $context: "thread status: needs user input" });
    case "request":
      return gt("Request", { $context: "thread status: guest request" });
    case "failed":
      return gt("Failed", { $context: "thread status" });
    case "done":
      return gt("Done", { $context: "thread status" });
    default:
      return null;
  }
}

function ServerThreadTab({
  threadRef,
  ...props
}: TabProps & { readonly threadRef: ScopedThreadRef }) {
  const gt = useGT();
  const thread = useThreadShell(threadRef);
  const localLastVisitedAt = useUiStateStore(
    (state) => state.threadLastVisitedAtById[scopedThreadKey(threadRef)],
  );
  const instanceId = thread
    ? (thread.runtime?.providerInstanceId ?? thread.modelSelection.instanceId)
    : null;
  const provider = useThreadTabProvider(threadRef.environmentId, instanceId);
  let status: TabAvatarStatus = null;
  if (thread) {
    const lastVisitedAt = resolveThreadLastVisitedAt(thread.lastVisitedAt, localLastVisitedAt);
    const rowStatus = resolveSidebarRowStatus({ ...thread, lastVisitedAt });
    status =
      rowStatus === "preparing" || rowStatus === "working"
        ? "working"
        : rowStatus === "limited"
          ? "failed"
          : rowStatus === "ready"
            ? !props.active && hasUnseenCompletion({ ...thread, lastVisitedAt })
              ? "done"
              : null
            : rowStatus;
  }
  const model = thread
    ? provider?.entry.models.find((candidate) => candidate.slug === thread.modelSelection.model)
    : undefined;
  const modelLabel = thread
    ? model
      ? getTriggerDisplayModelName(model, provider?.entry.driverKind)
      : thread.modelSelection.model
    : null;
  const project = thread ? props.projectFor(thread.environmentId, thread.projectId) : null;
  return (
    <ThreadTabFrame
      {...props}
      title={thread?.title ?? gt("Loading thread")}
      environmentId={threadRef.environmentId}
      project={project}
      provider={provider}
      status={status}
      modelLabel={modelLabel}
      draft={false}
    />
  );
}

function DraftThreadTab({ draftId, ...props }: TabProps & { readonly draftId: string }) {
  const gt = useGT();
  const environmentId = useComposerDraftStore(
    (store) => store.draftThreadsByThreadKey[draftId]?.environmentId ?? null,
  );
  const projectId = useComposerDraftStore(
    (store) => store.draftThreadsByThreadKey[draftId]?.projectId ?? null,
  );
  return (
    <ThreadTabFrame
      {...props}
      title={gt("New thread")}
      environmentId={environmentId}
      project={
        environmentId !== null && projectId !== null
          ? props.projectFor(environmentId, projectId)
          : null
      }
      provider={null}
      status={null}
      modelLabel={null}
      draft
    />
  );
}

function ThreadTabFrame(
  props: TabProps & {
    readonly title: string;
    readonly environmentId: EnvironmentId | null;
    readonly project: EnvironmentProject | null;
    readonly provider: TabProvider | null;
    readonly status: TabAvatarStatus;
    readonly modelLabel: string | null;
    readonly draft: boolean;
  },
) {
  const gt = useGT();
  const { environmentId, primaryEnvironmentId, project, provider } = props;
  const remote =
    environmentId !== null &&
    primaryEnvironmentId !== null &&
    environmentId !== primaryEnvironmentId;
  const machineLabel = remote ? props.environmentLabel(environmentId) : null;
  // Inside its project's group the chip already names the project.
  const showProjectName = project !== null && props.group?.project === undefined;
  const statusLabel = useStatusLabel(props.status);
  const accent = provider ? kaluwaInstanceAccent(provider.entry.accentColor) : undefined;

  const tabRef = useRef<HTMLDivElement>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- scrolls the newly active tab into the visible part of the strip
  useEffect(() => {
    const tab = tabRef.current;
    const list = tab?.closest<HTMLElement>(".kaluwa-tabs-list");
    if (!props.active || !tab || !list) return;
    // Scrolls only the strip; scrollIntoView would also shift the clipped chat column.
    const tabRect = tab.getBoundingClientRect();
    const listRect = list.getBoundingClientRect();
    if (tabRect.left < listRect.left) list.scrollLeft -= listRect.left - tabRect.left + 16;
    else if (tabRect.right > listRect.right) list.scrollLeft += tabRect.right - listRect.right + 16;
  }, [props.active]);

  const handleAuxClick = (event: ReactMouseEvent) => {
    if (event.button !== 1) return;
    event.preventDefault();
    props.onClose();
  };

  return (
    <Tooltip>
      <TooltipTrigger
        delay={600}
        render={
          <div
            ref={tabRef}
            role="tab"
            data-kaluwa-tab=""
            data-kaluwa-tab-key={props.tabKey}
            data-pinned={props.pinned || undefined}
            aria-selected={props.active}
            aria-label={project !== null ? `${project.title} · ${props.title}` : props.title}
            tabIndex={props.active ? 0 : -1}
            className={cn("kaluwa-tab", !props.active && "max-md:hidden")}
            onClick={props.onClick}
            onAuxClick={handleAuxClick}
            onMouseDown={(event) => {
              if (event.button === 1) event.preventDefault();
            }}
            onContextMenu={props.onContextMenu}
            onKeyDown={props.onKeyDown}
            onPointerDown={props.onPointerDown}
            onPointerMove={props.onPointerMove}
            onPointerUp={props.onPointerUp}
            onPointerCancel={props.onPointerCancel}
          />
        }
      >
        <TabIdentity
          project={project}
          provider={provider}
          status={props.status}
          draft={props.draft}
        />
        {props.renaming ? (
          <RenameInput
            initial={props.title}
            label={gt("Thread title")}
            className="kaluwa-tab-title-input"
            onCommit={(value) => props.onCommitRename(value, props.title)}
            onCancel={props.onCancelRename}
          />
        ) : (
          <span className="kaluwa-tab-label">
            {showProjectName ? (
              <span className="kaluwa-tab-project-name">{project.title}</span>
            ) : null}
            <span className="kaluwa-tab-title" dir={textDirection(props.title)}>
              {props.title}
            </span>
          </span>
        )}
        {remote && environmentId !== null ? (
          <span
            className="kaluwa-tab-env"
            role="img"
            aria-label={
              machineLabel
                ? gt("Runs on {machine}", { machine: machineLabel })
                : gt("Runs on another machine")
            }
          >
            <EnvironmentMachineIcon kind={props.machineOf(environmentId)} aria-hidden />
          </span>
        ) : null}
        <button
          type="button"
          className="kaluwa-tab-close"
          aria-label={props.closeLabel}
          tabIndex={-1}
          onClick={(event) => {
            event.stopPropagation();
            props.onClose();
          }}
        >
          <XIcon aria-hidden />
        </button>
      </TooltipTrigger>
      <TooltipPopup side="bottom">
        <span className="kaluwa-tab-card">
          {project !== null ? (
            <span className="kaluwa-tab-card-row kaluwa-tab-card-meta">
              <ProjectFavicon
                project={project}
                className="kaluwa-folder-icon kaluwa-tab-card-icon"
              />
              <span className="kaluwa-tab-card-project">{project.title}</span>
              {machineLabel ? <span>{gt("on {machine}", { machine: machineLabel })}</span> : null}
            </span>
          ) : null}
          <span className="kaluwa-tab-card-title" dir={textDirection(props.title)}>
            {props.title}
          </span>
          {provider !== null ? (
            <span className="kaluwa-tab-card-row">
              <ProviderInstanceIcon
                driverKind={provider.entry.driverKind}
                displayName={provider.entry.displayName}
                accentColor={provider.entry.accentColor}
                acpRegistryAgentId={provider.entry.acpRegistryAgentId}
                acpRegistryIconUrl={provider.entry.acpRegistryIconUrl}
                size="compact"
              />
              <span
                className="kaluwa-tab-card-provider"
                style={accent ? { color: accent } : undefined}
              >
                {provider.entry.displayName}
              </span>
              <span
                className="kaluwa-tab-card-initials"
                style={accent ? { backgroundColor: accent } : undefined}
              >
                {providerInstanceInitials(provider.entry.displayName)}
              </span>
              {props.modelLabel ? (
                <span className="kaluwa-tab-card-meta">{props.modelLabel}</span>
              ) : null}
            </span>
          ) : null}
          {statusLabel !== null ? (
            <span className="kaluwa-tab-card-row kaluwa-tab-card-meta">
              <span className="kaluwa-tab-card-dot" data-kaluwa-status={props.status ?? "idle"} />
              {statusLabel}
            </span>
          ) : null}
        </span>
      </TooltipPopup>
    </Tooltip>
  );
}
