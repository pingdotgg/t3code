import { Outlet, createFileRoute, redirect, useParams } from "@tanstack/react-router";
import { useEffect } from "react";
import { useShallow } from "zustand/react/shallow";

import { useCommandPaletteStore } from "../commandPaletteStore";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import {
  startNewLocalThreadFromContext,
  startNewThreadFromContext,
} from "../lib/chatThreadActions";
import { isTerminalFocused } from "../lib/terminalFocus";
import { resolveShortcutCommand } from "../keybindings";
import { QuickThreadSearchDialog } from "../components/QuickThreadSearchDialog";
import { GlobalThreadSearchDialog } from "../components/GlobalThreadSearchDialog";
import { ProjectFolderSearchDialog } from "../components/ProjectFolderSearchDialog";
import { useGlobalThreadSearchStore } from "../globalThreadSearchStore";
import { useQuickThreadSearchStore } from "../quickThreadSearchStore";
import { useProjectFolderSearchStore } from "../projectFolderSearchStore";
import { selectThreadTerminalState, useTerminalStateStore } from "../terminalStateStore";
import {
  selectProjectsAcrossEnvironments,
  selectThreadsAcrossEnvironments,
  useStore,
} from "../store";
import { resolveThreadRouteTarget } from "../threadRoutes";
import { useThreadSelectionStore } from "../threadSelectionStore";
import { resolveSidebarNewThreadEnvMode } from "~/components/Sidebar.logic";
import { useSettings } from "~/hooks/useSettings";
import { useServerKeybindings } from "~/rpc/serverState";
import { useSkillPickerStore } from "~/skillPickerStore";
import { useSnippetPickerStore } from "~/snippetPickerStore";

function isBlockingDialogOpen(): boolean {
  return (
    document.querySelector('[data-slot="dialog-popup"], [data-slot="command-dialog-popup"]') !==
    null
  );
}

function ChatRouteGlobalShortcuts() {
  const clearSelection = useThreadSelectionStore((state) => state.clearSelection);
  const selectedThreadKeysSize = useThreadSelectionStore((state) => state.selectedThreadKeys.size);
  const { activeDraftThread, activeThread, defaultProjectRef, handleNewThread, routeThreadRef } =
    useHandleNewThread();
  const keybindings = useServerKeybindings();
  const terminalOpen = useTerminalStateStore((state) =>
    routeThreadRef
      ? selectThreadTerminalState(state.terminalStateByThreadKey, routeThreadRef).terminalOpen
      : false,
  );
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

      if (useCommandPaletteStore.getState().open) {
        return;
      }

      if (isBlockingDialogOpen()) {
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
        return;
      }

      if (command === "snippets.open") {
        event.preventDefault();
        event.stopPropagation();
        useSnippetPickerStore.getState().openPicker();
        return;
      }

      if (command === "skills.open") {
        event.preventDefault();
        event.stopPropagation();
        useSkillPickerStore.getState().openPicker();
        return;
      }

      if (command === "threads.search") {
        event.preventDefault();
        event.stopPropagation();
        useQuickThreadSearchStore.getState().openDialog();
        return;
      }

      if (command === "threads.searchAll") {
        event.preventDefault();
        event.stopPropagation();
        useGlobalThreadSearchStore.getState().openDialog();
        return;
      }

      if (command === "projects.search") {
        event.preventDefault();
        event.stopPropagation();
        useProjectFolderSearchStore.getState().openDialog();
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
    handleNewThread,
    keybindings,
    defaultProjectRef,
    selectedThreadKeysSize,
    terminalOpen,
    appSettings.defaultThreadEnvMode,
  ]);

  return null;
}

function ChatRouteQuickThreadSearch() {
  const open = useQuickThreadSearchStore((state) => state.open);
  const focusRequestId = useQuickThreadSearchStore((state) => state.focusRequestId);
  const closeDialog = useQuickThreadSearchStore((state) => state.closeDialog);
  const routeTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  const projects = useStore(useShallow(selectProjectsAcrossEnvironments));
  const threads = useStore(useShallow(selectThreadsAcrossEnvironments));
  const activeThreadRef = routeTarget?.kind === "server" ? routeTarget.threadRef : null;

  if (!open) {
    return null;
  }

  return (
    <QuickThreadSearchDialog
      open={open}
      focusRequestId={focusRequestId}
      threads={threads}
      projects={projects}
      activeThreadRef={activeThreadRef}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          closeDialog();
        }
      }}
    />
  );
}

function ChatRouteGlobalThreadSearch() {
  const open = useGlobalThreadSearchStore((state) => state.open);
  const focusRequestId = useGlobalThreadSearchStore((state) => state.focusRequestId);
  const closeDialog = useGlobalThreadSearchStore((state) => state.closeDialog);
  const routeTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  const projects = useStore(useShallow(selectProjectsAcrossEnvironments));
  const threads = useStore(useShallow(selectThreadsAcrossEnvironments));
  const activeThreadRef = routeTarget?.kind === "server" ? routeTarget.threadRef : null;

  if (!open) {
    return null;
  }

  return (
    <GlobalThreadSearchDialog
      open={open}
      focusRequestId={focusRequestId}
      threads={threads}
      projects={projects}
      activeThreadRef={activeThreadRef}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          closeDialog();
        }
      }}
    />
  );
}

function ChatRouteProjectFolderSearch() {
  const open = useProjectFolderSearchStore((state) => state.open);
  const focusRequestId = useProjectFolderSearchStore((state) => state.focusRequestId);
  const closeDialog = useProjectFolderSearchStore((state) => state.closeDialog);
  const projects = useStore(useShallow(selectProjectsAcrossEnvironments));
  const { handleNewThread } = useHandleNewThread();
  const appSettings = useSettings();

  if (!open) {
    return null;
  }

  return (
    <ProjectFolderSearchDialog
      open={open}
      focusRequestId={focusRequestId}
      projects={projects}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          closeDialog();
        }
      }}
      onSelectProject={async (projectRef) => {
        await handleNewThread(projectRef, {
          envMode: resolveSidebarNewThreadEnvMode({
            defaultEnvMode: appSettings.defaultThreadEnvMode,
          }),
        });
      }}
    />
  );
}

function ChatRouteLayout() {
  return (
    <>
      <ChatRouteGlobalShortcuts />
      <ChatRouteQuickThreadSearch />
      <ChatRouteGlobalThreadSearch />
      <ChatRouteProjectFolderSearch />
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
