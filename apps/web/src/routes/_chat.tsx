import { useTaskWorkbench } from "../state/taskWorkbench";
import { Outlet, createFileRoute, redirect, useParams } from "@tanstack/react-router";
import { useAtomValue } from "@effect/atom-react";
import { useEffect, useMemo } from "react";

import { isCommandPaletteOpen } from "../commandPaletteBus";
import { useClientSettings, useLegacySidebarEnabled } from "../hooks/useSettings";
import { openCommandPalette } from "../commandPaletteBus";
import { scopeTaskRef } from "@t3tools/client-runtime/environment";
import { useTask } from "../state/tasks";
import { resolveThreadRouteTarget } from "../threadRoutes";
import { useProjects, useServerConfigs } from "../state/entities";
import { usePrimaryEnvironmentId } from "../state/environments";
import { selectProjectGroupingSettings } from "../logicalProject";
import { buildSidebarProjectSnapshots } from "../sidebarProjectGrouping";
import { dispatchPreviewAction } from "../components/preview/previewActionBus";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { resolveNewThreadInTaskTarget, startNewThreadFromContext } from "../lib/chatThreadActions";
import { isPreviewFocused } from "../lib/previewFocus";
import { isTerminalFocused } from "../lib/terminalFocus";
import { resolveShortcutCommand } from "../keybindings";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../terminalUiStateStore";
import { isPreviewSupportedInRuntime } from "../previewStateStore";
import { selectActiveRightPanel, useRightPanelStore } from "../rightPanelStore";
import { useThreadSelectionStore } from "../threadSelectionStore";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { primaryServerKeybindingsAtom } from "~/state/server";

function ChatRouteGlobalShortcuts() {
  const clearSelection = useThreadSelectionStore((state) => state.clearSelection);
  const selectedThreadKeysSize = useThreadSelectionStore((state) => state.selectedThreadKeys.size);
  const { activeDraftThread, activeThread, defaultProjectRef, handleNewThread, routeThreadRef } =
    useHandleNewThread();
  const routeTarget = useParams({ strict: false, select: resolveThreadRouteTarget });
  const memberTaskId = activeThread ? activeThread.taskId : activeDraftThread?.taskId;
  const memberEnvironmentId = activeThread?.environmentId ?? activeDraftThread?.environmentId;
  const taskRef =
    routeTarget?.kind === "task"
      ? routeTarget.taskRef
      : memberTaskId && memberEnvironmentId
        ? scopeTaskRef(memberEnvironmentId, memberTaskId)
        : null;
  const task = useTask(taskRef);
  const serverConfigs = useServerConfigs();
  const taskCreationTarget = resolveNewThreadInTaskTarget({
    task,
    taskRef,
    supportsTasks:
      taskRef !== null &&
      serverConfigs.get(taskRef.environmentId)?.environment.capabilities.tasks === true,
  });
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const legacySidebarEnabled = useLegacySidebarEnabled();
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
  const { ref: workbenchRef } = useTaskWorkbench(
    routeThreadRef,
    activeThread ?? activeDraftThread,
    routeTarget?.kind === "task" ? routeTarget.taskRef : null,
  );
  const terminalOpen = useTerminalUiStateStore((state) =>
    workbenchRef
      ? selectThreadTerminalUiState(state.terminalUiStateByThreadKey, workbenchRef).terminalOpen
      : false,
  );
  // The `previewOpen` shortcut-context flag here uses the store-only value;
  // the URL-aware arbitration lives inside ChatView's `onTogglePreview`,
  // which we invoke via the action bus to avoid duplicating the rule.
  const previewOpen = useRightPanelStore((state) =>
    workbenchRef ? selectActiveRightPanel(state.byThreadKey, workbenchRef) === "preview" : false,
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

      if (command === "chat.newInTask" && taskCreationTarget) {
        event.preventDefault();
        event.stopPropagation();
        void handleNewThread(taskCreationTarget.projectRef, { taskId: taskCreationTarget.taskId });
        return;
      }

      if (command === "chat.new" || command === "chat.newInTask") {
        event.preventDefault();
        event.stopPropagation();
        // The default sidebar routes creation through the command palette
        // whenever there is a real choice to make; the legacy sidebar (and
        // single-project setups) keep the immediate contextual create.
        if (!legacySidebarEnabled && projectGroupCount > 1) {
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
    routeThreadRef,
    selectedThreadKeysSize,
    legacySidebarEnabled,
    terminalOpen,
    taskCreationTarget,
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
