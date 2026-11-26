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
import { PlusIcon, XIcon } from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type ComponentProps,
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
import { useThreadShell } from "../../state/entities";
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
import { KaluwaThreadAvatar } from "../sidebar/KaluwaThreadAvatar";
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

/** Groups the list's children into drag units, in content coordinates. */
function measureDragUnits(list: HTMLElement, groupDrag: boolean): DragUnit[] {
  const listLeft = list.getBoundingClientRect().left - list.scrollLeft;
  const units: Array<{ elements: HTMLElement[]; first: string | null; last: string | null }> = [];
  let open: { id: string; unit: (typeof units)[number] } | null = null;
  for (const child of list.children) {
    if (!(child instanceof HTMLElement)) continue;
    const key = child.dataset.kaluwaTabKey ?? null;
    const chip = child.dataset.kaluwaGroupChip;
    const group = child.dataset.kaluwaGroup;
    if (!groupDrag) {
      if (key !== null) units.push({ elements: [child], first: key, last: key });
      continue;
    }
    if (child.dataset.pinned !== undefined) continue;
    if (chip !== undefined) {
      const unit = { elements: [child], first: null, last: null };
      units.push(unit);
      open = { id: chip, unit };
      continue;
    }
    if (group !== undefined && open?.id === group && key !== null) {
      open.unit.elements.push(child);
      open.unit.first ??= key;
      open.unit.last = key;
      continue;
    }
    open = null;
    if (key !== null) units.push({ elements: [child], first: key, last: key });
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

  const menuContext: ThreadTabMenuContext = { router, startRename: setRenaming };

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
    if ((event.target as HTMLElement).closest("button:not([data-kaluwa-group-chip]), input")) {
      return;
    }
    const list = event.currentTarget.parentElement;
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
      drag.from = drag.units.findIndex((unit) => unit.elements.includes(drag.element));
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
    const sibling =
      event.key === "ArrowLeft"
        ? event.currentTarget.previousElementSibling
        : event.currentTarget.nextElementSibling;
    if (sibling instanceof HTMLElement) sibling.focus();
  };

  const handleWheel = (event: ReactWheelEvent<HTMLElement>) => {
    if (event.deltaX !== 0 || event.deltaY === 0) return;
    event.currentTarget.scrollLeft += event.deltaY;
  };

  const closeLabel = closeTabShortcut
    ? gt("Close tab ({shortcut})", { shortcut: closeTabShortcut })
    : gt("Close tab");
  const groupsById = new Map(state.groups.map((group) => [group.id, group]));
  const items: ReactNode[] = [];
  const chippedGroups = new Set<string>();
  for (const key of state.tabs) {
    const target = parseThreadTabKey(key);
    if (target === null) continue;
    const group = groupsById.get(state.groupOf[key] ?? "") ?? null;
    if (group !== null && !chippedGroups.has(group.id)) {
      chippedGroups.add(group.id);
      items.push(
        <ThreadTabGroupChip
          key={`group:${group.id}`}
          group={group}
          count={state.tabs.filter((tab) => state.groupOf[tab] === group.id).length}
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
        />,
      );
    }
    const active = key === activeKey;
    if (group?.collapsed && !active) continue;
    const tabProps: TabProps = {
      tabKey: key,
      active,
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
    };
    items.push(
      target.kind === "thread" ? (
        <ServerThreadTab key={key} threadRef={target.ref} {...tabProps} />
      ) : (
        <DraftThreadTab key={key} draftId={target.draftId} {...tabProps} />
      ),
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

function ThreadTabGroupChip(
  props: PointerHandlers & {
    readonly group: ThreadTabGroup;
    readonly count: number;
    readonly renaming: boolean;
    readonly onToggle: () => void;
    readonly onContextMenu: (event: ReactMouseEvent) => void;
    readonly onCommitRename: (name: string) => void;
    readonly onCancelRename: () => void;
  },
) {
  const gt = useGT();
  const { group } = props;
  const label = group.name.length > 0 ? group.name : gt("Unnamed group");
  if (props.renaming) {
    return (
      <span
        className="kaluwa-tab-group-chip max-md:hidden"
        data-kaluwa-group-chip={group.id}
        data-kaluwa-group-color={group.color}
      >
        <RenameInput
          initial={group.name}
          label={gt("Group name")}
          className="kaluwa-tab-group-input"
          onCommit={props.onCommitRename}
          onCancel={props.onCancelRename}
        />
      </span>
    );
  }
  return (
    <button
      type="button"
      className="kaluwa-tab-group-chip max-md:hidden"
      data-kaluwa-group-chip={group.id}
      data-kaluwa-group-color={group.color}
      data-collapsed={group.collapsed || undefined}
      data-unnamed={group.name.length === 0 || undefined}
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
    >
      {group.name.length > 0 ? <span className="kaluwa-tab-group-name">{group.name}</span> : null}
      {group.collapsed ? <span className="kaluwa-tab-group-count">{props.count}</span> : null}
    </button>
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
};

type TabAvatarStatus = ComponentProps<typeof KaluwaThreadAvatar>["status"];

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
  return (
    <ThreadTabFrame
      {...props}
      title={thread?.title ?? gt("Loading thread")}
      environmentId={threadRef.environmentId}
      avatar={
        <KaluwaThreadAvatar
          providerEntry={provider?.entry ?? null}
          showInstanceBadge={provider?.showBadge ?? false}
          status={status}
          recede={false}
        />
      }
    />
  );
}

function DraftThreadTab({ draftId, ...props }: TabProps & { readonly draftId: string }) {
  const gt = useGT();
  const environmentId = useComposerDraftStore(
    (store) => store.draftThreadsByThreadKey[draftId]?.environmentId ?? null,
  );
  return (
    <ThreadTabFrame
      {...props}
      title={gt("New thread")}
      environmentId={environmentId}
      avatar={<PlusIcon aria-hidden className="kaluwa-tab-draft-icon" />}
    />
  );
}

function ThreadTabFrame(
  props: TabProps & {
    readonly title: string;
    readonly environmentId: EnvironmentId | null;
    readonly avatar: ReactNode;
  },
) {
  const gt = useGT();
  const { environmentId, primaryEnvironmentId } = props;
  const remote =
    environmentId !== null &&
    primaryEnvironmentId !== null &&
    environmentId !== primaryEnvironmentId;
  const machineLabel = remote ? props.environmentLabel(environmentId) : null;

  const tabRef = useRef<HTMLDivElement>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- scrolls the newly active tab into the visible part of the strip
  useEffect(() => {
    const tab = tabRef.current;
    const list = tab?.parentElement;
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
            data-kaluwa-group={props.group?.id}
            data-kaluwa-group-color={props.group?.color}
            data-pinned={props.pinned || undefined}
            aria-selected={props.active}
            aria-label={props.pinned ? props.title : undefined}
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
        {props.avatar}
        {props.renaming ? (
          <RenameInput
            initial={props.title}
            label={gt("Thread title")}
            className="kaluwa-tab-title-input"
            onCommit={(value) => props.onCommitRename(value, props.title)}
            onCancel={props.onCancelRename}
          />
        ) : (
          <span className="kaluwa-tab-title" dir={textDirection(props.title)}>
            {props.title}
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
        <span className="block max-w-80 truncate">{props.title}</span>
        {machineLabel ? (
          <span className="block text-muted-foreground">
            {gt("Runs on {machine}", { machine: machineLabel })}
          </span>
        ) : null}
      </TooltipPopup>
    </Tooltip>
  );
}
