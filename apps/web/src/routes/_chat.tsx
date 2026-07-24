import { Outlet, createFileRoute, redirect } from "@tanstack/react-router";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { useAtomValue } from "@effect/atom-react";
import { useEffect, useMemo } from "react";

import { isCommandPaletteOpen } from "../commandPaletteBus";
import { useClientSettings } from "../hooks/useSettings";
import { openCommandPalette } from "../commandPaletteBus";
import { useProjects } from "../state/entities";
import { usePrimaryEnvironmentId } from "../state/environments";
import { selectProjectGroupingSettings } from "../logicalProject";
import { buildSidebarProjectSnapshots } from "../sidebarProjectGrouping";
import { dispatchPreviewAction } from "../components/preview/previewActionBus";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { startNewThreadFromContext } from "../lib/chatThreadActions";
import { getTerminalFocusOwner } from "../lib/terminalFocus";
import { sharedCloseFocusTracker } from "../lib/closeFocus";
import { resolveShortcutCommand } from "../keybindings";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../terminalUiStateStore";
import { isPreviewSupportedInRuntime } from "../previewStateStore";
import { selectThreadRightPanelState, useRightPanelStore } from "../rightPanelStore";
import { useThreadSelectionStore } from "../threadSelectionStore";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { primaryServerKeybindingsAtom } from "~/state/server";

function ChatRouteGlobalShortcuts() {
  const clearSelection = useThreadSelectionStore((state) => state.clearSelection);
  const selectedThreadKeysSize = useThreadSelectionStore((state) => state.selectedThreadKeys.size);
  const { activeDraftThread, activeThread, defaultProjectRef, handleNewThread, routeThreadRef } =
    useHandleNewThread();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const sidebarV2Enabled = useClientSettings((settings) => settings.sidebarV2Enabled);
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const projects = useProjects();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const projectGroupCount = useMemo(
    () =>
      buildSidebarProjectSnapshots({
        projects,
        settings: projectGroupingSettings,
        primaryEnvironmentId,
        resolveEnvironmentLabel: () => null,
      }).length,
    [primaryEnvironmentId, projectGroupingSettings, projects],
  );
  const terminalOpen = useTerminalUiStateStore((state) =>
    routeThreadRef
      ? selectThreadTerminalUiState(state.terminalUiStateByThreadKey, routeThreadRef).terminalOpen
      : false,
  );
  const rightPanelState = useRightPanelStore((state) =>
    selectThreadRightPanelState(state.byThreadKey, routeThreadRef),
  );
  const activeRightPanelSurface = rightPanelState.surfaces.find(
    (surface) => surface.id === rightPanelState.activeSurfaceId,
  );
  const previewOpen = rightPanelState.isOpen && activeRightPanelSurface?.kind === "preview";
  const rightPanelPreviewTabIds = useMemo(
    () =>
      rightPanelState.surfaces.flatMap((surface) =>
        surface.kind === "preview" && surface.resourceId !== null ? [surface.resourceId] : [],
      ),
    [rightPanelState.surfaces],
  );
  const rightPanelScopeKey = routeThreadRef ? scopedThreadKey(routeThreadRef) : null;
  useEffect(() => {
    const onWindowKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const closeFocusOwner = sharedCloseFocusTracker.current({
        rightPanelOpen: rightPanelState.isOpen,
        rightPanelPreviewTabIds,
        rightPanelScopeKey,
      });
      const terminalFocusOwner = getTerminalFocusOwner();
      const command = resolveShortcutCommand(event, keybindings, {
        context: {
          terminalFocus: terminalFocusOwner !== null || closeFocusOwner === "drawer-terminal",
          terminalOpen,
          previewFocus: previewOpen && closeFocusOwner === "right-panel",
          previewOpen,
          rightPanelFocus: closeFocusOwner === "right-panel",
        },
      });

      if (isCommandPaletteOpen()) {
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
        void startNewThreadFromContext({
          activeDraftThread,
          activeThread: activeThread ?? undefined,
          defaultProjectRef,
          handleNewThread,
        });
        return;
      }

      if (command === "chat.new") {
        event.preventDefault();
        event.stopPropagation();
        // Sidebar v2 routes creation through the command palette whenever
        // there is a real choice to make; v1 (and single-project setups)
        // keep the immediate contextual create.
        if (sidebarV2Enabled && projectGroupCount > 1) {
          openCommandPalette({ open: "new-thread-in" });
          return;
        }
        void startNewThreadFromContext({
          activeDraftThread,
          activeThread: activeThread ?? undefined,
          defaultProjectRef,
          handleNewThread,
        });
        return;
      }

      if (command === "preview.toggle") {
        event.preventDefault();
        event.stopPropagation();
        if (!routeThreadRef) return;
        if (!isPreviewSupportedInRuntime()) {
          toastManager.add(
            stackedThreadToast({
              type: "info",
              title: "Preview is desktop-only",
              description: "Open T3 Code in the desktop app to use the in-app preview.",
            }),
          );
          return;
        }
        dispatchPreviewAction("toggle-panel");
        return;
      }

      // The remaining preview commands only fire when the panel is the
      // currently-focused tenant. The `when: previewFocus` rule already
      // gates this, but defend against the keybinding being misconfigured.
      if (
        command === "preview.refresh" ||
        command === "preview.focusUrl" ||
        command === "preview.zoomIn" ||
        command === "preview.zoomOut" ||
        command === "preview.resetZoom"
      ) {
        event.preventDefault();
        event.stopPropagation();
        const action =
          command === "preview.refresh"
            ? "refresh"
            : command === "preview.focusUrl"
              ? "focus-url"
              : command === "preview.zoomIn"
                ? "zoom-in"
                : command === "preview.zoomOut"
                  ? "zoom-out"
                  : "reset-zoom";
        dispatchPreviewAction(action);
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
    previewOpen,
    projectGroupCount,
    rightPanelPreviewTabIds,
    rightPanelScopeKey,
    rightPanelState.isOpen,
    routeThreadRef,
    selectedThreadKeysSize,
    sidebarV2Enabled,
    terminalOpen,
  ]);

  return null;
}

function ChatRouteLayout() {
  return (
    <>
      <ChatRouteGlobalShortcuts />
      <Outlet />
    </>
  );
}

export const Route = createFileRoute("/_chat")({
  beforeLoad: async ({ context }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  component: ChatRouteLayout,
});
