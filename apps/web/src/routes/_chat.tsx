import { type ResolvedKeybindingsConfig } from "@t3tools/contracts";
import { useQuery } from "@tanstack/react-query";
import { Outlet, createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

import { CommandPaletteProvider, useCommandPalette } from "../components/CommandPalette";
import ThreadSidebar from "../components/Sidebar";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import {
  startNewLocalThreadFromContext,
  startNewThreadFromContext,
} from "../lib/chatThreadActions";
import { isTerminalFocused } from "../lib/terminalFocus";
import { serverConfigQueryOptions } from "../lib/serverReactQuery";
import { resolveShortcutCommand } from "../keybindings";
import { selectThreadTerminalState, useTerminalStateStore } from "../terminalStateStore";
import { useThreadSelectionStore } from "../threadSelectionStore";
import { Sidebar, SidebarProvider } from "~/components/ui/sidebar";
import { useAppSettings } from "~/appSettings";

const EMPTY_KEYBINDINGS: ResolvedKeybindingsConfig = [];

function ChatRouteGlobalShortcuts() {
  const clearSelection = useThreadSelectionStore((state) => state.clearSelection);
  const selectedThreadIdsSize = useThreadSelectionStore((state) => state.selectedThreadIds.size);
  const { activeDraftThread, activeThread, handleNewThread, projects, routeThreadId } =
    useHandleNewThread();
  const { open: commandPaletteOpen, toggleOpen } = useCommandPalette();
  const serverConfigQuery = useQuery(serverConfigQueryOptions());
  const keybindings = serverConfigQuery.data?.keybindings ?? EMPTY_KEYBINDINGS;
  const terminalOpen = useTerminalStateStore((state) =>
    routeThreadId
      ? selectThreadTerminalState(state.terminalStateByThreadId, routeThreadId).terminalOpen
      : false,
  );
  const { settings: appSettings } = useAppSettings();

  useEffect(() => {
    const onWindowKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;

      const command = resolveShortcutCommand(event, keybindings, {
        context: {
          terminalFocus: isTerminalFocused(),
          terminalOpen,
        },
      });

      if (command === "commandPalette.toggle") {
        event.preventDefault();
        event.stopPropagation();
        toggleOpen();
        return;
      }

      if (commandPaletteOpen) {
        return;
      }

      if (event.key === "Escape" && selectedThreadIdsSize > 0) {
        event.preventDefault();
        clearSelection();
        return;
      }

      if (command === "chat.newLocal") {
        event.preventDefault();
        event.stopPropagation();
        void startNewLocalThreadFromContext({
          activeDraftThread,
          activeThread,
          defaultThreadEnvMode: appSettings.defaultThreadEnvMode,
          handleNewThread,
          projects,
        });
        return;
      }

      if (command !== "chat.new") return;
      event.preventDefault();
      event.stopPropagation();
      void startNewThreadFromContext({
        activeDraftThread,
        activeThread,
        defaultThreadEnvMode: appSettings.defaultThreadEnvMode,
        handleNewThread,
        projects,
      });
    };

    window.addEventListener("keydown", onWindowKeyDown);
    return () => {
      window.removeEventListener("keydown", onWindowKeyDown);
    };
  }, [
    activeDraftThread,
    activeThread,
    clearSelection,
    commandPaletteOpen,
    handleNewThread,
    keybindings,
    projects,
    selectedThreadIdsSize,
    terminalOpen,
    toggleOpen,
    appSettings.defaultThreadEnvMode,
  ]);

  return null;
}

function ChatRouteLayout() {
  const navigate = useNavigate();

  useEffect(() => {
    const onMenuAction = window.desktopBridge?.onMenuAction;
    if (typeof onMenuAction !== "function") {
      return;
    }

    const unsubscribe = onMenuAction((action) => {
      if (action !== "open-settings") return;
      void navigate({ to: "/settings" });
    });

    return () => {
      unsubscribe?.();
    };
  }, [navigate]);

  return (
    <CommandPaletteProvider>
      <SidebarProvider defaultOpen>
        <ChatRouteGlobalShortcuts />
        <Sidebar
          side="left"
          collapsible="offcanvas"
          className="border-r border-border bg-card text-foreground"
        >
          <ThreadSidebar />
        </Sidebar>
        <Outlet />
      </SidebarProvider>
    </CommandPaletteProvider>
  );
}

export const Route = createFileRoute("/_chat")({
  component: ChatRouteLayout,
});
