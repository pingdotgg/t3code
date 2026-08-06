import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { useAtomValue } from "@effect/atom-react";
import { Outlet, createFileRoute, redirect, useSearch } from "@tanstack/react-router";
import { useEffect, useMemo } from "react";

import { orderItemsByPreferredIds } from "../components/Sidebar.logic";
import { resolveSessionGridProject } from "../components/sessionGrid/sessionGrid.logic";
import { isCommandPaletteOpen } from "../commandPaletteBus";
import { useClientSettings, useSidebarV2Enabled } from "../hooks/useSettings";
import { openCommandPalette } from "../commandPaletteBus";
import { useProjects } from "../state/entities";
import { usePrimaryEnvironmentId } from "../state/environments";
import { getProjectOrderKey, selectProjectGroupingSettings } from "../logicalProject";
import { buildSidebarProjectSnapshots } from "../sidebarProjectGrouping";
import { dispatchPreviewAction } from "../components/preview/previewActionBus";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { startNewThreadFromContext } from "../lib/chatThreadActions";
import { isPreviewFocused } from "../lib/previewFocus";
import { isTerminalFocused } from "../lib/terminalFocus";
import { resolveShortcutCommand } from "../keybindings";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../terminalUiStateStore";
import { isPreviewSupportedInRuntime } from "../previewStateStore";
import { selectActiveRightPanel, useRightPanelStore } from "../rightPanelStore";
import { useSourceControlStore } from "../sourceControlStore";
import { useThreadSelectionStore } from "../threadSelectionStore";
import { legacyProjectCwdPreferenceKey, useUiStateStore } from "../uiStateStore";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { primaryServerKeybindingsAtom } from "~/state/server";

/** fork: f4 source-control surface — `Cmd/Ctrl+Shift+G`, matching 2code. */
const SOURCE_CONTROL_PANEL_SHORTCUT_KEY = "g";

function ChatRouteGlobalShortcuts() {
  const clearSelection = useThreadSelectionStore((state) => state.clearSelection);
  const selectedThreadKeysSize = useThreadSelectionStore((state) => state.selectedThreadKeys.size);
  const { activeDraftThread, activeThread, defaultProjectRef, handleNewThread, routeThreadRef } =
    useHandleNewThread();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const sidebarV2Enabled = useSidebarV2Enabled();
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const projectSortOrder = useClientSettings((settings) => settings.sidebarProjectSortOrder);
  const projects = useProjects();
  const projectOrder = useUiStateStore((state) => state.projectOrder);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const orderedProjects = useMemo(
    () =>
      orderItemsByPreferredIds({
        items: projects,
        preferredIds: projectOrder,
        getId: getProjectOrderKey,
        getPreferenceIds: (project) => [
          getProjectOrderKey(project),
          legacyProjectCwdPreferenceKey(project.workspaceRoot),
        ],
      }),
    [projectOrder, projects],
  );
  const projectGroups = useMemo(
    () =>
      buildSidebarProjectSnapshots({
        projects: projectSortOrder === "manual" ? orderedProjects : projects,
        settings: projectGroupingSettings,
        primaryEnvironmentId,
        resolveEnvironmentLabel: () => null,
      }),
    [orderedProjects, primaryEnvironmentId, projectGroupingSettings, projectSortOrder, projects],
  );
  // fork: project session grid — global new-thread shortcuts inherit a
  // focused grid project just as they inherit a project from a thread route.
  const gridProjectKey =
    useSearch({
      from: "/_chat/grid",
      shouldThrow: false,
      select: (search) => search.project ?? null,
    }) ?? null;
  const gridProjectRef = useMemo(() => {
    const project = resolveSessionGridProject(projectGroups, gridProjectKey);
    return project ? scopeProjectRef(project.environmentId, project.id) : null;
  }, [gridProjectKey, projectGroups]);
  const shortcutProjectRef = gridProjectRef ?? defaultProjectRef;
  const terminalOpen = useTerminalUiStateStore((state) =>
    routeThreadRef
      ? selectThreadTerminalUiState(state.terminalUiStateByThreadKey, routeThreadRef).terminalOpen
      : false,
  );
  // The `previewOpen` shortcut-context flag here uses the store-only value;
  // the URL-aware arbitration lives inside ChatView's `onTogglePreview`,
  // which we invoke via the action bus to avoid duplicating the rule.
  const previewOpen = useRightPanelStore((state) =>
    routeThreadRef
      ? selectActiveRightPanel(state.byThreadKey, routeThreadRef) === "preview"
      : false,
  );
  useEffect(() => {
    const onWindowKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const command = resolveShortcutCommand(event, keybindings, {
        context: {
          terminalFocus: isTerminalFocused(),
          terminalOpen,
          previewFocus: isPreviewFocused(),
          previewOpen,
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

      // fork: f4 source-control surface — a fork-local shortcut, deliberately
      // NOT a `KeybindingCommand` in contracts: adding an id there is safe but
      // costs a contract edit for a binding nobody has asked to remap.
      if (
        (event.metaKey || event.ctrlKey) &&
        event.shiftKey &&
        event.key.toLowerCase() === SOURCE_CONTROL_PANEL_SHORTCUT_KEY
      ) {
        // Guard BEFORE preventDefault: with no resolved thread there is nothing
        // to toggle, and swallowing the chord would eat the browser's own
        // binding for it while doing nothing.
        if (!routeThreadRef) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        useSourceControlStore.getState().toggleOpen();
        return;
      }

      if (command === "chat.newLocal") {
        event.preventDefault();
        event.stopPropagation();
        if (gridProjectRef) {
          void handleNewThread(gridProjectRef, { navigate: false });
          return;
        }
        void startNewThreadFromContext({
          activeDraftThread,
          activeThread: activeThread ?? undefined,
          defaultProjectRef: shortcutProjectRef,
          handleNewThread,
        });
        return;
      }

      if (command === "chat.new") {
        event.preventDefault();
        event.stopPropagation();
        if (gridProjectRef) {
          void handleNewThread(gridProjectRef, { navigate: false });
          return;
        }
        // Sidebar v2 routes creation through the command palette whenever
        // there is a real choice to make; v1 (and single-project setups)
        // keep the immediate contextual create.
        if (gridProjectRef === null && sidebarV2Enabled && projectGroups.length > 1) {
          openCommandPalette({ open: "new-thread-in" });
          return;
        }
        void startNewThreadFromContext({
          activeDraftThread,
          activeThread: activeThread ?? undefined,
          defaultProjectRef: shortcutProjectRef,
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
    gridProjectRef,
    previewOpen,
    projectGroups.length,
    routeThreadRef,
    selectedThreadKeysSize,
    sidebarV2Enabled,
    shortcutProjectRef,
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
