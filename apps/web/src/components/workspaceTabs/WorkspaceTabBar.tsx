import { parseScopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ContextMenuItem } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { Columns2Icon, PinIcon, XIcon } from "lucide-react";
import { useEffect, useEffectEvent, useState, type DragEvent, type MouseEvent } from "react";

import { isThreadWorking } from "@t3tools/client-runtime/state/thread-inbox";

import { readLocalApi } from "../../localApi";
import { cn } from "../../lib/utils";
import { registerCommands } from "../../shortcuts/dispatcher";
import { useQuietThreadShell } from "../../state/entities";
import { buildThreadRouteParams } from "../../threadRoutes";
import {
  cycleTab,
  neighborAfterClose,
  otherTabKeys,
  tabKeysToRight,
} from "../../workspaceTabs.logic";
import { useWorkspaceTabsStore } from "../../workspaceTabsStore";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const TAB_DRAG_TYPE = "application/x-continuum-thread-tab";

type TabAction = "pin" | "split" | "close" | "close-others" | "close-right" | "reopen";

/** Browser-style tabs for the threads open in this window. */
export function WorkspaceTabBar({
  activeKey,
  draftActive,
}: {
  readonly activeKey: string | null;
  readonly draftActive: boolean;
}) {
  const navigate = useNavigate();
  const tabs = useWorkspaceTabsStore((state) => state.tabs);
  const hasClosed = useWorkspaceTabsStore((state) => state.closed.length > 0);
  const splitKey = useWorkspaceTabsStore((state) => state.split?.key ?? null);
  const [dragOver, setDragOver] = useState<string | null>(null);

  const show = (key: string | null) => {
    const ref = key === null ? null : parseScopedThreadKey(key);
    if (ref === null) return void navigate({ to: "/" });
    void navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(ref) });
  };

  const close = (keys: ReadonlyArray<string>) => {
    const store = useWorkspaceTabsStore.getState();
    if (activeKey !== null && keys.includes(activeKey)) {
      show(neighborAfterClose(store, activeKey, keys));
    }
    store.close(keys);
  };

  const reopen = () => {
    const key = useWorkspaceTabsStore.getState().reopen();
    if (key !== null) show(key);
  };

  const runShortcut = useEffectEvent((command: "next" | "previous" | "close" | "reopen") => {
    const state = useWorkspaceTabsStore.getState();
    if (command === "reopen") return reopen();
    if (command === "close") {
      if (activeKey !== null) close([activeKey]);
      return;
    }
    const next = cycleTab(state, activeKey, command === "next" ? 1 : -1);
    if (next !== null && next !== activeKey) show(next);
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers the tab shortcuts with the app's keyboard dispatcher while the bar is mounted
  useEffect(
    () =>
      registerCommands({
        "tabs.next": (event) => {
          event.preventDefault();
          runShortcut("next");
        },
        "tabs.previous": (event) => {
          event.preventDefault();
          runShortcut("previous");
        },
        "tabs.close": (event) => {
          event.preventDefault();
          runShortcut("close");
        },
        "tabs.reopenClosed": (event) => {
          event.preventDefault();
          runShortcut("reopen");
        },
      }),
    [],
  );

  const onContextMenu = (event: MouseEvent, key: string, pinned: boolean) => {
    const api = readLocalApi();
    if (!api) return;
    event.preventDefault();
    const state = useWorkspaceTabsStore.getState();
    const items: ContextMenuItem<TabAction>[] = [
      { id: "pin", label: pinned ? "Unpin tab" : "Pin tab" },
      { id: "split", label: "Open beside current thread", disabled: key === activeKey },
      { id: "close", label: "Close tab", separatorBefore: true },
      {
        id: "close-others",
        label: "Close other tabs",
        disabled: otherTabKeys(state, key).length === 0,
      },
      {
        id: "close-right",
        label: "Close tabs to the right",
        disabled: tabKeysToRight(state, key).length === 0,
      },
      { id: "reopen", label: "Reopen closed tab", disabled: !hasClosed, separatorBefore: true },
    ];
    void api.contextMenu.show(items, { x: event.clientX, y: event.clientY }).then((action) => {
      const current = useWorkspaceTabsStore.getState();
      if (action === "pin") current.togglePin(key);
      else if (action === "split") current.openSplit(key, activeKey);
      else if (action === "close") close([key]);
      else if (action === "close-others") close(otherTabKeys(current, key));
      else if (action === "close-right") close(tabKeysToRight(current, key));
      else if (action === "reopen") reopen();
    });
  };

  if (tabs.length === 0 && !draftActive) return null;

  return (
    <div
      role="tablist"
      aria-label="Open threads"
      data-workspace-tabs
      className="flex h-9 shrink-0 items-end gap-0.5 overflow-x-auto overflow-y-hidden border-b border-border/70 px-2 [scrollbar-width:none]"
    >
      {tabs.map((tab) => (
        <WorkspaceTabItem
          key={tab.key}
          tabKey={tab.key}
          pinned={tab.pinned}
          active={tab.key === activeKey}
          split={tab.key === splitKey}
          dragOver={dragOver === tab.key}
          onSelect={() => show(tab.key)}
          onClose={() => close([tab.key])}
          onContextMenu={(event) => onContextMenu(event, tab.key, tab.pinned)}
          onDragOver={(event) => {
            if (!event.dataTransfer.types.includes(TAB_DRAG_TYPE)) return;
            event.preventDefault();
            setDragOver(tab.key);
          }}
          onDragLeave={() => setDragOver((current) => (current === tab.key ? null : current))}
          onDrop={(event) => {
            const from = event.dataTransfer.getData(TAB_DRAG_TYPE);
            setDragOver(null);
            if (from) useWorkspaceTabsStore.getState().move(from, tab.key);
          }}
        />
      ))}
      {draftActive ? (
        <div
          role="tab"
          aria-selected
          className="flex h-8 max-w-48 shrink-0 items-center rounded-t-md border border-b-0 border-border/70 bg-background px-3 text-xs font-medium"
        >
          New thread
        </div>
      ) : null}
    </div>
  );
}

function WorkspaceTabItem(props: {
  readonly tabKey: string;
  readonly pinned: boolean;
  readonly active: boolean;
  readonly split: boolean;
  readonly dragOver: boolean;
  readonly onSelect: () => void;
  readonly onClose: () => void;
  readonly onContextMenu: (event: MouseEvent) => void;
  readonly onDragOver: (event: DragEvent) => void;
  readonly onDragLeave: () => void;
  readonly onDrop: (event: DragEvent) => void;
}) {
  const ref = parseScopedThreadKey(props.tabKey);
  const shell = useQuietThreadShell(ref);
  const deleted = shell?.deletedAt != null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- drops the tab of a thread the server reports deleted
  useEffect(() => {
    if (deleted) useWorkspaceTabsStore.getState().close([props.tabKey]);
  }, [deleted, props.tabKey]);
  if (deleted) return null;
  const title = shell?.title.trim() || "Thread";
  const working = shell !== null && isThreadWorking(shell);

  const tab = (
    <div
      role="tab"
      aria-selected={props.active}
      draggable
      data-workspace-tab={props.tabKey}
      onDragStart={(event) => {
        event.dataTransfer.setData(TAB_DRAG_TYPE, props.tabKey);
        event.dataTransfer.effectAllowed = "move";
      }}
      onDragOver={props.onDragOver}
      onDragLeave={props.onDragLeave}
      onDrop={props.onDrop}
      onClick={props.onSelect}
      onAuxClick={(event) => {
        if (event.button === 1) {
          event.preventDefault();
          props.onClose();
        }
      }}
      onContextMenu={props.onContextMenu}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          props.onSelect();
        }
      }}
      tabIndex={props.active ? 0 : -1}
      className={cn(
        "group/tab flex h-8 shrink-0 cursor-default select-none items-center gap-1.5 rounded-t-md border border-b-0 px-2.5 text-xs",
        props.pinned ? "max-w-32" : "w-44 max-w-44",
        props.active
          ? "border-border/70 bg-background font-medium text-foreground"
          : "border-transparent text-muted-foreground hover:bg-accent/60 hover:text-foreground",
        props.dragOver && "ring-1 ring-inset ring-ring",
      )}
    >
      {props.pinned ? <PinIcon aria-label="Pinned" className="size-3 shrink-0" /> : null}
      {props.split ? <Columns2Icon aria-label="Shown beside" className="size-3 shrink-0" /> : null}
      {working ? (
        <span aria-label="Working" className="size-1.5 shrink-0 rounded-full bg-primary" />
      ) : null}
      <span className="min-w-0 flex-1 truncate">{title}</span>
      {props.pinned ? null : (
        <button
          type="button"
          aria-label={`Close ${title}`}
          className={cn(
            "-me-1 flex size-4 shrink-0 items-center justify-center rounded-sm hover:bg-accent",
            props.active ? "opacity-100" : "opacity-0 group-hover/tab:opacity-100",
          )}
          onClick={(event) => {
            event.stopPropagation();
            props.onClose();
          }}
        >
          <XIcon className="size-3" />
        </button>
      )}
    </div>
  );
  return (
    <Tooltip>
      <TooltipTrigger render={tab} />
      <TooltipPopup side="bottom">{title}</TooltipPopup>
    </Tooltip>
  );
}
