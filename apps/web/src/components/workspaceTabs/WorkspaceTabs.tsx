import { parseScopedThreadKey, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { MessageSquareIcon, PlusIcon, SquarePenIcon, XIcon } from "lucide-react";
import { useAtomValue } from "@effect/atom-react";
import { useEffect } from "react";

import { isElectron } from "../../env";
import { useHandleNewThread } from "../../hooks/useHandleNewThread";
import { useThreadRouteTarget } from "../../hooks/useThreadRouteTarget";
import { startNewThreadFromContext } from "../../lib/chatThreadActions";
import { cn } from "../../lib/utils";
import { openCommandPalette } from "../../commandPaletteBus";
import { useThreadShell } from "../../state/entities";
import { primaryServerProvidersAtom } from "../../state/server";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { buildThreadRouteParams } from "../../threadRoutes";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "../../workspaceTitlebar";
import { neighborTabKey, useWorkspaceTabsStore } from "./workspaceTabsStore";

const TAB_CLASS =
  "group/tab relative flex h-7.5 min-w-0 max-w-56 flex-1 items-center rounded-md text-sm [-webkit-app-region:no-drag]";
const TAB_BODY_CLASS =
  "flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-md pr-7 pl-2 text-left outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset";
const ACTIVE_TAB_CLASS = "bg-foreground/10 text-foreground";
const IDLE_TAB_CLASS =
  "bg-foreground/4 text-foreground opacity-65 hover:bg-foreground/7 hover:opacity-100";

function ThreadTab({
  threadRef,
  active,
  onSelect,
  onClose,
}: {
  threadRef: ScopedThreadRef;
  active: boolean;
  onSelect: () => void;
  onClose: () => void;
}) {
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
        className={TAB_BODY_CLASS}
      >
        {icon}
        <span className="truncate">{thread.title}</span>
      </button>
      <button
        type="button"
        aria-label={`Close ${thread.title}`}
        onClick={onClose}
        className="absolute right-1 grid size-5 place-items-center rounded-sm text-muted-foreground opacity-0 outline-hidden group-hover/tab:opacity-100 group-focus-within/tab:opacity-100 hover:bg-foreground/10 hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      >
        <XIcon aria-hidden className="size-3" />
      </button>
    </div>
  );
}

export function WorkspaceTabs() {
  const navigate = useNavigate();
  const routeTarget = useThreadRouteTarget();
  const keys = useWorkspaceTabsStore((state) => state.keys);
  const openTab = useWorkspaceTabsStore((state) => state.open);
  const closeTab = useWorkspaceTabsStore((state) => state.close);
  const newThreadContext = useHandleNewThread();
  const activeKey = routeTarget?.kind === "server" ? scopedThreadKey(routeTarget.threadRef) : null;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- records the routed thread in the persisted tab store
  useEffect(() => {
    if (activeKey) openTab(activeKey);
  }, [activeKey, openTab]);

  const showThread = (ref: ScopedThreadRef) =>
    void navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(ref) });

  const close = (key: string) => {
    if (key === activeKey) {
      const next = neighborTabKey(keys, key);
      const nextRef = next ? parseScopedThreadKey(next) : null;
      if (nextRef) showThread(nextRef);
      else void navigate({ to: "/" });
    }
    closeTab(key);
  };

  const startNewThread = () =>
    void startNewThreadFromContext({
      activeDraftThread: newThreadContext.activeDraftThread,
      activeThread: newThreadContext.activeThread ?? undefined,
      defaultProjectRef: newThreadContext.defaultProjectRef,
      handleNewThread: newThreadContext.handleNewThread,
    }).then((started) => {
      if (!started) openCommandPalette({ open: "new-thread-in" });
    });

  return (
    <nav
      className={cn(
        "hidden h-10 shrink-0 items-center gap-0.5 overflow-x-auto pr-2.5 pl-1.5 md:flex",
        isElectron && "drag-region",
        COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
      )}
      aria-label="Open threads"
    >
      {keys.map((key) => {
        const ref = parseScopedThreadKey(key);
        if (!ref) return null;
        return (
          <ThreadTab
            key={key}
            threadRef={ref}
            active={key === activeKey}
            onSelect={() => showThread(ref)}
            onClose={() => close(key)}
          />
        );
      })}
      {routeTarget?.kind === "draft" ? (
        <div aria-current="page" className={cn(TAB_CLASS, ACTIVE_TAB_CLASS, "gap-1.5 px-2")}>
          <SquarePenIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate">New thread</span>
        </div>
      ) : null}
      <button
        type="button"
        aria-label="New tab"
        onClick={startNewThread}
        className="ml-0.5 grid size-7.5 shrink-0 place-items-center rounded-md bg-foreground/4 text-muted-foreground opacity-65 outline-hidden [-webkit-app-region:no-drag] hover:bg-foreground/7 hover:opacity-100 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      >
        <PlusIcon className="size-4" />
      </button>
    </nav>
  );
}
