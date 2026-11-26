// Fork: Kaluwa's titlebar tabs. With tabs on, the chat titlebar shows one tab per open thread or
// new-thread draft instead of the thread breadcrumb; with them off it is upstream's ChatHeader.
// Styles live in the "Kaluwa titlebar tabs" block of index.css.
import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";
import { useGT } from "gt-react";
import { PlusIcon, XIcon } from "lucide-react";
import {
  useEffect,
  useRef,
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
import { parseThreadTabKey, type ThreadTabKey } from "../../kaluwa/kaluwaThreadTabs.logic";
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
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  activateThreadTab,
  closeThreadTabAndFollow,
  moveThreadTabTo,
  openNewThreadTab,
  registerThreadTabStrip,
  syncThreadTabRoute,
  threadTabKeyForRouteTarget,
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

type TabDrag = {
  readonly key: ThreadTabKey;
  readonly pointerId: number;
  readonly startX: number;
  readonly element: HTMLElement;
  readonly siblings: ReadonlyArray<HTMLElement>;
  readonly rects: ReadonlyArray<DOMRect>;
  readonly from: number;
  to: number;
  dragging: boolean;
};

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
  const tabs = live.tabs.length === 0 && routeKey !== null ? [routeKey] : live.tabs;
  const activeKey = routeKey !== null && tabs.includes(routeKey) ? routeKey : live.active;
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const machines = useEnvironmentMachines();
  const { environments } = useEnvironments();
  const dragRef = useRef<TabDrag | null>(null);
  const suppressClickRef = useRef(false);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the saved tab list follows the router's thread, opening or replacing a tab
  useEffect(() => {
    if (routeKey !== null) syncThreadTabRoute(router);
  }, [routeKey, router]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers the tab shortcuts with the keyboard dispatcher and a document middle-click listener
  useEffect(() => registerThreadTabStrip(router), [router]);

  const activeThreadRef = scopeThreadRef(header.activeThreadEnvironmentId, header.activeThreadId);
  const canShareWithGuest = useAtomValue(canShareWithGuestAtom(header.activeThreadEnvironmentId));
  const { openMenu } = useThreadActionMenu({
    threadRef: header.isServerThread ? activeThreadRef : null,
    projectCwd: header.activeProject?.workspaceRoot ?? null,
    onFind: header.onFindInThread,
    canShareWithGuest,
  });

  const shortcutOptions = { context: { kaluwaTabs: true } };
  const newTabShortcut = shortcutLabelForCommand(keybindings, "threadTab.new", shortcutOptions);
  const closeTabShortcut = shortcutLabelForCommand(keybindings, "threadTab.close", shortcutOptions);

  const environmentLabel = (environmentId: EnvironmentId) =>
    environments.find((environment) => environment.environmentId === environmentId)?.label ?? null;

  const handleContextMenu = (event: ReactMouseEvent, key: ThreadTabKey) => {
    event.preventDefault();
    if (key !== activeKey) {
      activateThreadTab(router, key);
      return;
    }
    if (header.isServerThread)
      openMenu({ x: event.clientX, y: event.clientY }, contextMenuSourceOf(event));
  };

  const endDrag = (event: ReactPointerEvent) => {
    const drag = dragRef.current;
    if (drag === null || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (!drag.dragging) return;
    suppressClickRef.current = true;
    for (const element of drag.siblings) {
      element.style.transform = "";
      element.style.transition = "";
    }
    delete drag.element.dataset.dragging;
    if (drag.to !== drag.from) moveThreadTabTo(drag.key, drag.to);
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLElement>, key: ThreadTabKey) => {
    if (event.button !== 0 || !event.isPrimary) return;
    if ((event.target as HTMLElement).closest("button")) return;
    const list = event.currentTarget.parentElement;
    if (list === null) return;
    const siblings = [...list.querySelectorAll<HTMLElement>(":scope > [data-kaluwa-tab]")];
    const from = siblings.indexOf(event.currentTarget);
    if (from === -1) return;
    suppressClickRef.current = false;
    dragRef.current = {
      key,
      pointerId: event.pointerId,
      startX: event.clientX,
      element: event.currentTarget,
      siblings,
      rects: siblings.map((element) => element.getBoundingClientRect()),
      from,
      to: from,
      dragging: false,
    };
  };

  // Only `transform` changes while dragging; the order is saved once on release.
  const handlePointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (drag === null || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.startX;
    if (!drag.dragging) {
      if (Math.abs(dx) < DRAG_THRESHOLD_PX) return;
      drag.dragging = true;
      drag.element.setPointerCapture(event.pointerId);
      drag.element.dataset.dragging = "";
    }
    const own = drag.rects[drag.from]!;
    const center = own.left + own.width / 2 + dx;
    let to = drag.from;
    drag.rects.forEach((rect, index) => {
      const middle = rect.left + rect.width / 2;
      if (index > drag.from && center > middle) to = Math.max(to, index);
      if (index < drag.from && center < middle) to = Math.min(to, index);
    });
    drag.to = to;
    const next = drag.rects[drag.from + 1];
    const previous = drag.rects[drag.from - 1];
    const gap = next ? next.left - own.right : previous ? own.left - previous.right : 0;
    const step = own.width + gap;
    drag.siblings.forEach((element, index) => {
      if (index === drag.from) {
        element.style.transform = `translateX(${dx}px)`;
        return;
      }
      element.style.transition = "transform 150ms ease-out";
      const shift =
        index > drag.from && index <= to ? -step : index < drag.from && index >= to ? step : 0;
      element.style.transform = shift === 0 ? "" : `translateX(${shift}px)`;
    });
  };

  const handleClick = (key: ThreadTabKey) => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    if (key !== activeKey) activateThreadTab(router, key);
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLElement>, key: ThreadTabKey) => {
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
        {tabs.map((key) => {
          const target = parseThreadTabKey(key);
          if (target === null) return null;
          const active = key === activeKey;
          const tabProps = {
            tabKey: key,
            active,
            onClick: () => handleClick(key),
            onClose: () => closeThreadTabAndFollow(router, key),
            onContextMenu: (event: ReactMouseEvent) => handleContextMenu(event, key),
            onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => handleKeyDown(event, key),
            onPointerDown: (event: ReactPointerEvent<HTMLElement>) => handlePointerDown(event, key),
            onPointerMove: handlePointerMove,
            onPointerUp: endDrag,
            onPointerCancel: endDrag,
            closeLabel: closeTabShortcut
              ? gt("Close tab ({shortcut})", { shortcut: closeTabShortcut })
              : gt("Close tab"),
            primaryEnvironmentId,
            machineOf: (environmentId: EnvironmentId) => machines.get(environmentId) ?? "server",
            environmentLabel,
          };
          return target.kind === "thread" ? (
            <ServerThreadTab key={key} threadRef={target.ref} {...tabProps} />
          ) : (
            <DraftThreadTab key={key} draftId={target.draftId} {...tabProps} />
          );
        })}
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

type TabProps = {
  readonly tabKey: ThreadTabKey;
  readonly active: boolean;
  readonly onClick: () => void;
  readonly onClose: () => void;
  readonly onContextMenu: (event: ReactMouseEvent) => void;
  readonly onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => void;
  readonly onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  readonly onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
  readonly onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void;
  readonly onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => void;
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
            aria-selected={props.active}
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
        <span className="kaluwa-tab-title" dir={textDirection(props.title)}>
          {props.title}
        </span>
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
