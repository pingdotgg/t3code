import { Outlet, createFileRoute, redirect } from "@tanstack/react-router";
import { useAtomValue } from "@effect/atom-react";
import { useEffect, useMemo } from "react";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { effectiveSettled } from "@t3tools/client-runtime/state/thread-settled";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

import { isCommandPaletteOpen } from "../commandPaletteBus";
import { useClientSettings, useLegacySidebarEnabled } from "../hooks/useSettings";
import { openCommandPalette } from "../commandPaletteBus";
import { useProjects, readProject, useThreadShell } from "../state/entities";
import { usePrimaryEnvironmentId } from "../state/environments";
import { selectProjectGroupingSettings } from "../logicalProject";
import { buildSidebarProjectSnapshots } from "../sidebarProjectGrouping";
import {
  resolveDisplayedThreadPr,
  threadChangeRequestSnapshotsAtom,
} from "../components/ThreadStatusIndicators";
import { dispatchPreviewAction } from "../components/preview/previewActionBus";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { useThreadActions } from "../hooks/useThreadActions";
import { startNewThreadFromContext } from "../lib/chatThreadActions";
import { isPreviewFocused } from "../lib/previewFocus";
import { isTerminalFocused } from "../lib/terminalFocus";
import { resolveShortcutCommand } from "../keybindings";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../terminalUiStateStore";
import { isPreviewSupportedInRuntime } from "../previewStateStore";
import { selectActiveRightPanel, useRightPanelStore } from "../rightPanelStore";
import { useThreadSelectionStore } from "../threadSelectionStore";
import { useEnvironmentQuery } from "../state/query";
import { vcsEnvironment } from "../state/vcs";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { environmentServerConfigsAtom, primaryServerKeybindingsAtom } from "~/state/server";

function ChatRouteGlobalShortcuts() {
  const clearSelection = useThreadSelectionStore((state) => state.clearSelection);
  const selectedThreadKeysSize = useThreadSelectionStore((state) => state.selectedThreadKeys.size);
  const { activeDraftThread, activeThread, defaultProjectRef, handleNewThread, routeThreadRef } =
    useHandleNewThread();
  const activeThreadShell = useThreadShell(routeThreadRef);
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
  const { settleThread, unsettleThread } = useThreadActions();
  const serverConfigs = useAtomValue(environmentServerConfigsAtom);
  const changeRequestSnapshotByKey = useAtomValue(threadChangeRequestSnapshotsAtom);
  const autoSettleAfterDays = useClientSettings((settings) => settings.sidebarAutoSettleAfterDays);
  const autoSettleOnMerge = useClientSettings((settings) => settings.sidebarAutoSettleOnMerge);
  // PR resolution mirrors ChatView's banner exactly: live VCS status first,
  // snapshot second. The snapshot alone (Sidebar-written) is missing on the
  // legacy sidebar or before a row mounts, which would misclassify settle.
  const gitStatusCwd =
    activeThreadShell?.worktreePath ??
    (routeThreadRef && activeThreadShell
      ? (readProject({
          environmentId: routeThreadRef.environmentId,
          projectId: activeThreadShell.projectId,
        })?.workspaceRoot ?? null)
      : null);
  const gitStatusQuery = useEnvironmentQuery(
    routeThreadRef === null || gitStatusCwd === null
      ? null
      : vcsEnvironment.status({
          environmentId: routeThreadRef.environmentId,
          input: { cwd: gitStatusCwd },
        }),
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

      if (command === "chat.new") {
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
        return;
      }

      if (command === "thread.settle.toggle") {
        event.preventDefault();
        event.stopPropagation();
        if (event.repeat) return;
        if (!routeThreadRef || !activeThreadShell) return;
        const supportsSettlement =
          serverConfigs.get(routeThreadRef.environmentId)?.environment.capabilities
            .threadSettlement === true;
        if (!supportsSettlement) return;
        const threadKey = scopedThreadKey(routeThreadRef);
        // Same PR resolution as ChatView's banner: resolveDisplayedThreadPr
        // over live git status + the snapshot map.
        const activeThreadPr = resolveDisplayedThreadPr({
          threadBranch: activeThreadShell.branch,
          gitStatus: gitStatusQuery.data ?? null,
          snapshot: changeRequestSnapshotByKey.get(threadKey),
          retainTerminalOnBranchMismatch: activeThreadShell.worktreePath === null,
        });
        const changeRequest =
          activeThreadPr === null
            ? null
            : { state: activeThreadPr.state, updatedAt: activeThreadPr.updatedAt };
        // Classify like ChatView's parked-thread banner and the header menu:
        // effectiveSettled alone, minute-quantized so it cannot disagree
        // with those surfaces within the same minute.
        const isSettled = effectiveSettled(activeThreadShell, {
          now: `${new Date().toISOString().slice(0, 16)}:00.000Z`,
          autoSettleAfterDays,
          autoSettleOnMerge,
          changeRequest,
        });
        void (async () => {
          const result = isSettled
            ? await unsettleThread(routeThreadRef)
            : await settleThread(routeThreadRef);
          if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
            const error = squashAtomCommandFailure(result);
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: isSettled ? "Failed to un-settle thread" : "Failed to settle thread",
                description: error instanceof Error ? error.message : "An error occurred.",
              }),
            );
          }
        })();
        return;
      }
    };

    window.addEventListener("keydown", onWindowKeyDown);
    return () => {
      window.removeEventListener("keydown", onWindowKeyDown);
    };
  }, [
    activeDraftThread,
    activeThread,
    activeThreadShell,
    autoSettleAfterDays,
    autoSettleOnMerge,
    changeRequestSnapshotByKey,
    clearSelection,
    handleNewThread,
    gitStatusQuery.data,
    keybindings,
    defaultProjectRef,
    previewOpen,
    projectGroupCount,
    routeThreadRef,
    selectedThreadKeysSize,
    legacySidebarEnabled,
    serverConfigs,
    settleThread,
    terminalOpen,
    unsettleThread,
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
