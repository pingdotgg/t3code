import { Outlet, createFileRoute, redirect } from "@tanstack/react-router";
import { useEffect } from "react";

import { useCommandPaletteStore } from "../commandPaletteStore";
import { WorkspaceShell } from "../components/workspace/WorkspaceShell";
import {
  isWorkspaceCommandId,
  useWorkspaceCommandExecutor,
} from "../hooks/useWorkspaceCommandExecutor";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import {
  startNewLocalThreadFromContext,
  startNewThreadFromContext,
} from "../lib/chatThreadActions";
import { isTerminalFocused } from "../lib/terminalFocus";
import { resolveShortcutCommand } from "../keybindings";
import { useThreadSelectionStore } from "../threadSelectionStore";
import { useWorkspaceThreadTerminalOpen } from "../workspace/store";
import { useFocusedWorkspaceSurface, useWorkspaceStore } from "../workspace/store";
import { resolveSidebarNewThreadEnvMode } from "~/components/Sidebar.logic";
import { useSettings } from "~/hooks/useSettings";
import { useServerKeybindings } from "~/rpc/serverState";

function ChatRouteGlobalShortcuts() {
  const clearSelection = useThreadSelectionStore((state) => state.clearSelection);
  const selectedThreadKeysSize = useThreadSelectionStore((state) => state.selectedThreadKeys.size);
  const { activeDraftThread, activeThread, defaultProjectRef, handleNewThread, routeThreadRef } =
    useHandleNewThread();
  const { executeWorkspaceCommand } = useWorkspaceCommandExecutor();
  const focusedWorkspaceSurface = useFocusedWorkspaceSurface();
  const closeFocusedWindow = useWorkspaceStore((state) => state.closeFocusedWindow);
  const keybindings = useServerKeybindings();
  const terminalOpen = useWorkspaceThreadTerminalOpen(routeThreadRef);
  const appSettings = useSettings();

  useEffect(() => {
    const onWindowKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const command = resolveShortcutCommand(event, keybindings, {
        context: {
          terminalFocus: isTerminalFocused(),
          terminalOpen,
        },
      });
      const isFocusedStandaloneTerminal = focusedWorkspaceSurface?.kind === "terminal";
      if (command && isWorkspaceCommandId(command)) {
        event.preventDefault();
        event.stopPropagation();
        void executeWorkspaceCommand(command);
        return;
      }

      if (isFocusedStandaloneTerminal) {
        if (command === "terminal.split") {
          event.preventDefault();
          event.stopPropagation();
          void executeWorkspaceCommand("workspace.terminal.splitRight");
          return;
        }

        if (command === "terminal.new") {
          event.preventDefault();
          event.stopPropagation();
          void executeWorkspaceCommand("workspace.terminal.newTab");
          return;
        }

        if (command === "terminal.close") {
          event.preventDefault();
          event.stopPropagation();
          closeFocusedWindow();
          return;
        }
      }

      if (useCommandPaletteStore.getState().open) {
        return;
      }

      if (event.key === "Escape" && selectedThreadKeysSize > 0) {
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
          defaultProjectRef,
          defaultThreadEnvMode: resolveSidebarNewThreadEnvMode({
            defaultEnvMode: appSettings.defaultThreadEnvMode,
          }),
          handleNewThread,
        });
        return;
      }

      if (command === "chat.new") {
        event.preventDefault();
        event.stopPropagation();
        void startNewThreadFromContext({
          activeDraftThread,
          activeThread,
          defaultProjectRef,
          defaultThreadEnvMode: resolveSidebarNewThreadEnvMode({
            defaultEnvMode: appSettings.defaultThreadEnvMode,
          }),
          handleNewThread,
        });
      }
    };

    window.addEventListener("keydown", onWindowKeyDown);
    return () => {
      window.removeEventListener("keydown", onWindowKeyDown);
    };
  }, [
    activeDraftThread,
    activeThread,
    clearSelection,
    closeFocusedWindow,
    handleNewThread,
    keybindings,
    defaultProjectRef,
    executeWorkspaceCommand,
    focusedWorkspaceSurface,
    selectedThreadKeysSize,
    terminalOpen,
    appSettings.defaultThreadEnvMode,
  ]);

  return null;
}

function ChatRouteLayout() {
  return (
    <>
      <ChatRouteGlobalShortcuts />
      <WorkspaceShell />
      <Outlet />
    </>
  );
}

export const Route = createFileRoute("/_chat")({
  beforeLoad: async ({ context }) => {
    if (context.authGateState.status !== "authenticated") {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  component: ChatRouteLayout,
});
