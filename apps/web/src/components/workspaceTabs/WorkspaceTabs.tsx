import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ContextMenuItem, ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import type { ProviderInstanceId } from "@t3tools/contracts";
import {
  Columns2Icon,
  FileCodeIcon,
  MessageSquareIcon,
  NotebookTextIcon,
  PlusIcon,
  Rows2Icon,
  SettingsIcon,
  SquarePenIcon,
  SquareTerminalIcon,
  XIcon,
} from "lucide-react";
import { useAtomValue } from "@effect/atom-react";
import { type MouseEvent, type ReactNode, useEffect } from "react";

import { isElectron } from "../../env";
import { readLocalApi } from "../../localApi";
import { useHandleNewThread } from "../../hooks/useHandleNewThread";
import { useThreadRouteTarget } from "../../hooks/useThreadRouteTarget";
import { usePrimarySettings } from "../../hooks/useSettings";
import { resolveThreadActionProjectRef } from "../../lib/chatThreadActions";
import { useComposerDraftStore } from "../../composerDraftStore";
import { resolveAppModelSelectionForInstance } from "../../modelSelection";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { cn } from "../../lib/utils";
import { openCommandPalette } from "../../commandPaletteBus";
import { readThreadShell, useThreadShell } from "../../state/entities";
import { primaryServerProvidersAtom } from "../../state/server";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "../../workspaceTitlebar";
import { useThreadTerminalActions } from "../terminal/useThreadTerminalActions";
import { useShowThreadInMain } from "./WorkspaceSplit";
import { useNewTerminalTab } from "./WorkspaceSurfaceView";
import {
  neighborTabKey,
  parseWorkspaceTab,
  useWorkspaceTabsStore,
  type WorkspaceSplitDirection,
  type WorkspaceTab,
} from "./workspaceTabsStore";

const TAB_CLASS =
  "group/tab relative flex h-7.5 min-w-0 max-w-56 flex-1 items-center rounded-md text-sm [-webkit-app-region:no-drag]";
const TAB_BODY_CLASS =
  "flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-md pr-7 pl-2 text-left outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset";
const ACTIVE_TAB_CLASS = "bg-foreground/10 text-foreground";
const IDLE_TAB_CLASS =
  "bg-foreground/4 text-foreground opacity-65 hover:bg-foreground/7 hover:opacity-100";

function Tab({
  icon,
  label,
  active,
  onSelect,
  onClose,
  onContextMenu,
}: {
  icon: ReactNode;
  label: string;
  active: boolean;
  onSelect: () => void;
  onClose: () => void;
  onContextMenu?: ((event: MouseEvent) => void) | undefined;
}) {
  // The close button is a sibling, not a child, so assistive technology can reach it.
  return (
    <div className={cn(TAB_CLASS, active ? ACTIVE_TAB_CLASS : IDLE_TAB_CLASS)}>
      <button
        type="button"
        aria-current={active ? "page" : undefined}
        onClick={onSelect}
        onAuxClick={(event) => {
          if (event.button === 1) onClose();
        }}
        onContextMenu={onContextMenu}
        className={TAB_BODY_CLASS}
      >
        {icon}
        <span className="truncate">{label}</span>
      </button>
      <button
        type="button"
        aria-label={`Close ${label}`}
        onClick={onClose}
        className="absolute right-1 grid size-5 place-items-center rounded-sm text-muted-foreground opacity-0 outline-hidden group-hover/tab:opacity-100 group-focus-within/tab:opacity-100 hover:bg-foreground/10 hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      >
        <XIcon aria-hidden className="size-3" />
      </button>
    </div>
  );
}

type TabProps = {
  active: boolean;
  onSelect: () => void;
  onClose: () => void;
  onContextMenu?: ((event: MouseEvent) => void) | undefined;
};

const SPLIT_BUTTON_CLASS =
  "grid size-7.5 shrink-0 place-items-center rounded-md text-muted-foreground opacity-65 outline-hidden [-webkit-app-region:no-drag] hover:bg-foreground/7 hover:opacity-100 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset disabled:pointer-events-none disabled:opacity-30";

function ThreadTab({ threadRef, ...props }: TabProps & { threadRef: ScopedThreadRef }) {
  const thread = useThreadShell(threadRef);
  const providers = useAtomValue(primaryServerProvidersAtom);
  if (!thread) return null;
  const provider = providers.find((entry) => entry.instanceId === thread.providerInstanceId);
  const icon = provider ? (
    <ProviderInstanceIcon
      driverKind={provider.driver}
      displayName={provider.displayName ?? provider.driver}
      accentColor={provider.accentColor}
      size="compact"
      className="shrink-0"
    />
  ) : (
    <MessageSquareIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
  );
  return <Tab icon={icon} label={thread.title} {...props} />;
}

function TerminalTabButton({
  threadRef,
  terminalId,
  onClose,
  ...props
}: TabProps & { threadRef: ScopedThreadRef; terminalId: string }) {
  const terminalActions = useThreadTerminalActions(threadRef);
  return (
    <Tab
      icon={<SquareTerminalIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />}
      label="Terminal"
      onClose={() => {
        // Closing a terminal tab ends its shell, as in monocode.
        terminalActions.closeTerminalSession(terminalId);
        onClose();
      }}
      {...props}
    />
  );
}

function WorkspaceTabButton({ tab, ...props }: TabProps & { tab: WorkspaceTab }) {
  switch (tab.kind) {
    case "thread":
      return <ThreadTab threadRef={tab.threadRef} {...props} />;
    case "file":
      return (
        <Tab
          icon={<FileCodeIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />}
          label={tab.path.split("/").pop() ?? tab.path}
          {...props}
        />
      );
    case "terminal":
      return <TerminalTabButton threadRef={tab.threadRef} terminalId={tab.terminalId} {...props} />;
  }
}

export function WorkspaceTabs() {
  const navigate = useNavigate();
  const routeTarget = useThreadRouteTarget();
  const keys = useWorkspaceTabsStore((state) => state.keys);
  const surfaceKey = useWorkspaceTabsStore((state) => state.surfaceKey);
  const openTab = useWorkspaceTabsStore((state) => state.open);
  const closeTab = useWorkspaceTabsStore((state) => state.close);
  const showSurface = useWorkspaceTabsStore((state) => state.showSurface);
  const hideSurface = useWorkspaceTabsStore((state) => state.hideSurface);
  const splitKey = useWorkspaceTabsStore((state) => state.split?.key ?? null);
  const openSplit = useWorkspaceTabsStore((state) => state.openSplit);
  const closeSplit = useWorkspaceTabsStore((state) => state.closeSplit);
  const newThreadContext = useHandleNewThread();
  const newTerminalTab = useNewTerminalTab();
  const routedKey = routeTarget?.kind === "server" ? scopedThreadKey(routeTarget.threadRef) : null;
  const activeKey = surfaceKey ?? routedKey;

  const routedDraftId = routeTarget?.kind === "draft" ? routeTarget.draftId : null;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- records the routed thread in the persisted tab store, and leaves a file or terminal tab once another thread or draft is routed
  useEffect(() => {
    const { surfaceKey: shown } = useWorkspaceTabsStore.getState();
    const surface = shown ? parseWorkspaceTab(shown) : null;
    if (routedKey) {
      openTab(routedKey);
      if (surface && scopedThreadKey(surface.threadRef) !== routedKey) hideSurface();
    } else if (
      routedDraftId &&
      surface &&
      useComposerDraftStore.getState().getDraftIdByRef(surface.threadRef) !== routedDraftId
    ) {
      hideSurface();
    }
  }, [routedKey, routedDraftId, openTab, hideSurface]);

  const showThread = useShowThreadInMain();
  const splitShown = splitKey !== null && splitKey !== routedKey;
  // Only threads can take the split pane; offer the routed thread's nearest thread tab.
  const threadKeys = keys.filter((key) => parseWorkspaceTab(key)?.kind === "thread");
  const splitCandidate =
    (routedKey ? neighborTabKey(threadKeys, routedKey) : threadKeys.at(-1)) ?? null;

  const select = (key: string, tab: WorkspaceTab) => {
    if (tab.kind === "thread") {
      hideSurface();
      showThread(tab.threadRef);
      return;
    }
    showSurface(key);
    // A draft's thread has no route of its own; its tabs open over whatever is routed.
    if (scopedThreadKey(tab.threadRef) !== routedKey && readThreadShell(tab.threadRef)) {
      showThread(tab.threadRef);
    }
  };

  const close = (key: string) => {
    if (key === activeKey) {
      // The split pane's thread takes over the main pane when the main one closes.
      const next = (splitShown && key === routedKey ? splitKey : null) ?? neighborTabKey(keys, key);
      const nextTab = next ? parseWorkspaceTab(next) : null;
      if (next && nextTab) select(next, nextTab);
      else {
        hideSurface();
        if (key === routedKey) void navigate({ to: "/" });
      }
    }
    closeTab(key);
  };

  const showTabMenu = (event: MouseEvent, key: string) => {
    const api = readLocalApi();
    if (!api) return;
    event.preventDefault();
    const inMain = key === routedKey;
    const items: ContextMenuItem<WorkspaceSplitDirection | "close-split" | "close">[] = [
      { id: "right", label: "Split right", disabled: inMain },
      { id: "down", label: "Split down", disabled: inMain },
      ...(splitShown ? [{ id: "close-split" as const, label: "Close split" }] : []),
      { id: "close", label: "Close tab", separatorBefore: true },
    ];
    void api.contextMenu.show(items, { x: event.clientX, y: event.clientY }).then((action) => {
      if (action === "right" || action === "down") openSplit(key, action);
      else if (action === "close-split") closeSplit();
      else if (action === "close") close(key);
    });
  };

  const settings = usePrimarySettings();
  const providers = useAtomValue(primaryServerProvidersAtom).filter(
    (provider) => provider.enabled && provider.models.length > 0,
  );

  // A project keeps one draft, so from a draft without a provider pick "+" asks which project to start in.
  const startNewThread = async (instanceId?: ProviderInstanceId) => {
    const projectRef = resolveThreadActionProjectRef({
      activeDraftThread: newThreadContext.activeDraftThread,
      activeThread: newThreadContext.activeThread ?? undefined,
      defaultProjectRef: newThreadContext.defaultProjectRef,
      handleNewThread: newThreadContext.handleNewThread,
    });
    if (!projectRef || (routeTarget?.kind === "draft" && !instanceId)) {
      openCommandPalette({ open: "new-thread-in" });
      return;
    }
    const started = await newThreadContext.handleNewThread(projectRef);
    if (!started || !instanceId) return;
    // Like Orca's agent rows: start on the agent's last-used model, else its default.
    const drafts = useComposerDraftStore.getState();
    const provider = providers.find((entry) => entry.instanceId === instanceId);
    const model = resolveAppModelSelectionForInstance(
      instanceId,
      settings,
      providers,
      drafts.stickyModelSelectionByProvider[instanceId]?.model ??
        (provider?.models.find((entry) => entry.isDefault) ?? provider?.models[0])?.slug,
    );
    if (!model) return;
    drafts.setModelSelection(started.draftId, { instanceId, model }, { explicit: true });
  };

  return (
    <nav
      className={cn(
        "hidden h-10 shrink-0 items-center gap-0.5 overflow-x-auto pr-2.5 pl-1.5 md:flex",
        isElectron && "drag-region",
        COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
      )}
      aria-label="Open tabs"
    >
      {keys.map((key) => {
        const tab = parseWorkspaceTab(key);
        if (!tab) return null;
        return (
          <WorkspaceTabButton
            key={key}
            tab={tab}
            active={key === activeKey || (splitShown && key === splitKey)}
            onSelect={() => select(key, tab)}
            onClose={() => close(key)}
            onContextMenu={
              tab.kind === "thread" ? (event: MouseEvent) => showTabMenu(event, key) : undefined
            }
          />
        );
      })}
      {routeTarget?.kind === "draft" ? (
        <button
          type="button"
          aria-current={surfaceKey ? undefined : "page"}
          onClick={hideSurface}
          className={cn(TAB_CLASS, surfaceKey ? IDLE_TAB_CLASS : ACTIVE_TAB_CLASS, "gap-1.5 px-2")}
        >
          <SquarePenIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate">New thread</span>
        </button>
      ) : null}
      <Menu>
        <MenuTrigger
          render={
            <button
              type="button"
              aria-label="New tab"
              className="ml-0.5 grid size-7.5 shrink-0 place-items-center rounded-md bg-foreground/4 text-muted-foreground opacity-65 outline-hidden [-webkit-app-region:no-drag] hover:bg-foreground/7 hover:opacity-100 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset data-popup-open:opacity-100"
            />
          }
        >
          <PlusIcon className="size-4" />
        </MenuTrigger>
        <MenuPopup align="start" sideOffset={6} className="min-w-60">
          <MenuItem onClick={() => void startNewThread()}>
            <SquarePenIcon />
            New thread
          </MenuItem>
          <MenuItem disabled={!newTerminalTab} onClick={() => newTerminalTab?.()}>
            <SquareTerminalIcon />
            New terminal
          </MenuItem>
          <MenuItem onClick={() => void navigate({ to: "/notes" })}>
            <NotebookTextIcon />
            Notes
          </MenuItem>
          {providers.length > 0 ? <MenuSeparator /> : null}
          {providers.map((provider) => (
            <MenuItem
              key={provider.instanceId}
              onClick={() => void startNewThread(provider.instanceId)}
            >
              <ProviderInstanceIcon
                driverKind={provider.driver}
                displayName={provider.displayName ?? provider.driver}
                accentColor={provider.accentColor}
                size="compact"
              />
              <span className="truncate">{provider.displayName ?? provider.driver}</span>
            </MenuItem>
          ))}
          <MenuSeparator />
          <MenuItem onClick={() => void navigate({ to: "/settings/providers" })}>
            <SettingsIcon />
            Agent settings…
          </MenuItem>
        </MenuPopup>
      </Menu>
      <div className="ml-auto flex shrink-0 items-center gap-0.5 pl-2">
        {splitShown ? (
          <button
            type="button"
            aria-label="Close split"
            onClick={closeSplit}
            className={SPLIT_BUTTON_CLASS}
          >
            <XIcon className="size-4" />
          </button>
        ) : (
          (["right", "down"] as const).map((direction) => (
            <button
              key={direction}
              type="button"
              aria-label={direction === "right" ? "Split right" : "Split down"}
              disabled={splitCandidate === null}
              onClick={() => splitCandidate && openSplit(splitCandidate, direction)}
              className={SPLIT_BUTTON_CLASS}
            >
              {direction === "right" ? (
                <Columns2Icon className="size-4" />
              ) : (
                <Rows2Icon className="size-4" />
              )}
            </button>
          ))
        )}
      </div>
    </nav>
  );
}
