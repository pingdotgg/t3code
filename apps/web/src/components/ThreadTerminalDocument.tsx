import { useAtomValue } from "@effect/atom-react";
import {
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { resolveProjectScripts } from "@t3tools/shared/projectScripts";
import { useEffect, useMemo } from "react";

import { isCommandPaletteOpen } from "../commandPaletteBus";
import { useComposerDraftStore } from "../composerDraftStore";
import { useEnvironmentSettings } from "../hooks/useSettings";
import { useThreadActions } from "../hooks/useThreadActions";
import { useTheme } from "../hooks/useTheme";
import { resolveShortcutCommand } from "../keybindings";
import { isTerminalCloseConfirmPending } from "../lib/terminalCloseConfirm";
import {
  preventRepeatedTerminalCloseShortcut,
  preventTerminalCloseShortcut,
} from "../lib/terminalCloseShortcut";
import type { TerminalContextSelection } from "../lib/terminalContext";
import { getTerminalFocusOwner } from "../lib/terminalFocus";
import { useThreadPreviewState } from "../previewStateStore";
import { NO_PROVIDER_MODEL_SELECTION } from "../providerInstances";
import { projectScriptIdFromCommand } from "../projectScripts";
import {
  selectActiveRightPanelSurface,
  selectThreadRightPanelState,
  useRightPanelStore,
} from "../rightPanelStore";
import { useProject, useThread, useThreadShell } from "../state/entities";
import { useEnvironment } from "../state/environments";
import { primaryServerKeybindingsAtom } from "../state/server";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { useUiStateStore } from "../uiStateStore";
import { buildLocalDraftThread } from "./ChatView.logic";
import { ThreadTerminals } from "./ThreadTerminals";
import { handleThreadTerminalShortcut } from "./threadTerminalShortcuts";
import {
  useThreadTerminalActions,
  useThreadTerminalSessionState,
} from "./useThreadTerminalActions";
import { useThreadPanelClosing } from "./useThreadPanelClosing";
import { useThreadReferenceCopy } from "./useThreadReferenceCopy";
import { stackedThreadToast, toastManager } from "./ui/toast";

// This document has neither a composer nor the conversation's private error banner.
const ignore = () => undefined;
const addTerminalContext = (selection: TerminalContextSelection) => {
  void window.t3Shell?.dispatch("composer.terminalContext.add", selection);
};
function reportThreadCommandFailure(result: AtomCommandResult<unknown, unknown>, title: string) {
  if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
  const error = squashAtomCommandFailure(result);
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : "An error occurred.",
    }),
  );
}

/** The dedicated terminal document owns commands and retained sessions, without conversation setup. */
export function ThreadTerminalDocument({ threadRef }: { threadRef: ScopedThreadRef }) {
  useTheme();
  const draft = useComposerDraftStore((store) => store.getDraftSessionByRef(threadRef));
  const serverThread = useThread(threadRef, { waitForShell: draft !== null });
  const settings = useEnvironmentSettings(threadRef.environmentId);
  const project = useProject(
    serverThread
      ? scopeProjectRef(serverThread.environmentId, serverThread.projectId)
      : draft
        ? scopeProjectRef(draft.environmentId, draft.projectId)
        : null,
  );
  const localDraft = useMemo(
    () =>
      draft
        ? buildLocalDraftThread(
            threadRef.threadId,
            draft,
            project?.defaultModelSelection ??
              settings.defaultModelSelection ??
              NO_PROVIDER_MODEL_SELECTION,
          )
        : undefined,
    [draft, project?.defaultModelSelection, settings.defaultModelSelection, threadRef.threadId],
  );
  const thread = serverThread ?? localDraft;
  const activeEnvironmentId = thread?.environmentId;
  const activeThreadId = thread?.id;
  const activeThreadRef = useMemo(
    () =>
      activeEnvironmentId && activeThreadId
        ? scopeThreadRef(activeEnvironmentId, activeThreadId)
        : null,
    [activeEnvironmentId, activeThreadId],
  );
  const terminals = useThreadTerminalSessionState(threadRef, activeThreadRef);
  const actions = useThreadTerminalActions({
    environmentId: threadRef.environmentId,
    activeThreadRef,
    activeThread: thread,
    activeProject: project,
    terminals,
    setThreadError: ignore,
    focusComposer: ignore,
  });
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const scripts = useMemo(
    () => (project ? resolveProjectScripts(settings, project) : []),
    [project, settings],
  );
  const threadShell = useThreadShell(serverThread ? activeThreadRef : null);
  const environment = useEnvironment(thread?.environmentId ?? null);
  const capabilities = environment?.serverConfig?.environment.capabilities;
  const { settleThread, pinThread, confirmAndUnpinThread } = useThreadActions();
  const unsettleThread = useAtomCommand(threadEnvironment.unsettle, { reportFailure: false });
  const panel = useRightPanelStore((state) =>
    selectThreadRightPanelState(state.byThreadKey, activeThreadRef),
  );
  const activeSurface = useRightPanelStore((state) =>
    selectActiveRightPanelSurface(state.byThreadKey, activeThreadRef),
  );
  const preview = useThreadPreviewState(activeThreadRef);
  const { closeRightPanelSurface } = useThreadPanelClosing(
    activeThreadRef,
    preview,
    terminals.activeTerminalLabelsById,
  );
  const metadata = threadShell ?? thread;
  const copyReference = useThreadReferenceCopy(
    activeThreadRef,
    serverThread !== null,
    (metadata?.linkedPullRequest ?? metadata?.branchPullRequest)?.url ?? null,
  );
  const markThreadVisited = useUiStateStore((store) => store.markThreadVisited);
  useEffect(() => {
    const completedAt = serverThread?.latestTurn?.completedAt;
    if (!serverThread?.id || !completedAt) return;
    markThreadVisited(
      scopedThreadKey(scopeThreadRef(serverThread.environmentId, serverThread.id)),
      completedAt,
    );
  }, [
    markThreadVisited,
    serverThread?.environmentId,
    serverThread?.id,
    serverThread?.latestTurn?.completedAt,
  ]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (
        preventRepeatedTerminalCloseShortcut(event, keybindings) ||
        (isTerminalCloseConfirmPending() && preventTerminalCloseShortcut(event, keybindings))
      ) {
        event.stopPropagation();
        return;
      }
      if (!activeThreadRef || isCommandPaletteOpen()) return;
      const focusOwner = getTerminalFocusOwner();
      if (event.defaultPrevented && focusOwner === null) return;
      const command = resolveShortcutCommand(event, keybindings, {
        context: {
          terminalFocus: focusOwner !== null,
          terminalOpen: Boolean(terminals.terminalUiState.terminalOpen),
          modelPickerOpen: false,
        },
      });
      if (!command) return;
      if (handleThreadTerminalShortcut(command, event, terminals.terminalUiState, actions)) return;
      const consume = () => {
        event.preventDefault();
        event.stopPropagation();
      };
      switch (command) {
        case "thread.copyReference":
          consume();
          if (!event.repeat) copyReference();
          return;
        case "thread.settle":
          consume();
          if (!serverThread || capabilities?.threadSettlement !== true) return;
          if (threadShell?.settledOverride === "settled") {
            void unsettleThread({
              environmentId: activeThreadRef.environmentId,
              input: { threadId: activeThreadRef.threadId, reason: "user" },
            }).then((result) => reportThreadCommandFailure(result, "Failed to un-settle thread"));
          } else
            void settleThread(activeThreadRef).then((result) =>
              reportThreadCommandFailure(result, "Failed to settle thread"),
            );
          return;
        case "thread.pin": {
          consume();
          if (!serverThread || capabilities?.threadPinning !== true) return;
          const pinned = threadShell?.pinnedAt != null;
          void (pinned ? confirmAndUnpinThread(activeThreadRef) : pinThread(activeThreadRef)).then(
            (result) =>
              reportThreadCommandFailure(
                result,
                pinned ? "Failed to unpin thread" : "Failed to pin thread",
              ),
          );
          return;
        }
        case "rightPanel.toggle":
          consume();
          if (panel.isOpen) useRightPanelStore.getState().close(activeThreadRef);
          else useRightPanelStore.getState().toggleVisibility(activeThreadRef);
          return;
        case "rightPanel.close":
          if (!activeSurface) return;
          consume();
          if (!event.repeat) closeRightPanelSurface(activeSurface);
          return;
        case "diff.toggle":
          consume();
          if (serverThread) useRightPanelStore.getState().toggle(activeThreadRef, "diff");
          return;
        case "modelPicker.toggle":
        case "rightPanel.toggleMaximized":
          consume();
          return;
        default: {
          const scriptId = projectScriptIdFromCommand(command);
          const script =
            scriptId && project ? scripts.find((entry) => entry.id === scriptId) : undefined;
          if (!script) return;
          consume();
          void actions.runProjectScript(script);
        }
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [
    actions,
    activeSurface,
    activeThreadRef,
    capabilities,
    closeRightPanelSurface,
    confirmAndUnpinThread,
    copyReference,
    keybindings,
    panel.isOpen,
    pinThread,
    project,
    scripts,
    serverThread,
    settleThread,
    terminals.terminalUiState,
    threadShell,
    unsettleThread,
  ]);

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
      <ThreadTerminals
        threadRef={activeThreadRef}
        fill
        launchContext={actions.activeTerminalLaunchContext}
        focusRequestId={actions.terminalFocusRequestId}
        keybindings={keybindings}
        onAddTerminalContext={addTerminalContext}
      />
    </div>
  );
}
