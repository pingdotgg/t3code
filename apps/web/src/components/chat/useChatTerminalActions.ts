import { toggleThreadTerminalPane } from "../../layout/openRules";
import type { TerminalLaunchContext } from "../ThreadTerminalSurfaces";
export type { TerminalLaunchContext } from "../ThreadTerminalSurfaces";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import type { Dispatch } from "react";
import type { ComposerHandleRef } from "../../composerHandleContext";
import type { selectThreadTerminalUiState } from "../../terminalUiStateStore";
import { useStableCallback } from "../../hooks/useStableCallback";
import { useThreadTerminalActions } from "../terminal/useThreadTerminalActions";
import { getTerminalLabel } from "@t3tools/shared/terminalLabels";
import {
  AuthTerminalReadScope,
  AuthTerminalOperateScope,
  type EnvironmentId,
  type ProjectScript,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import { projectScriptTerminalInput } from "@t3tools/shared/projectScripts";
import { type SetStateAction } from "react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { MAX_TERMINALS_PER_GROUP } from "../../types";
import { isPreviewSupportedInRuntime } from "../../previewStateStore";
import { openUrlInPreview } from "../../browser/openFileInPreview";
import { resolveDiscoveredServerUrl } from "../../browser/browserTargetResolver";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { confirmTerminalClose } from "../../lib/terminalCloseConfirm";
import { findReusableProjectScriptTerminal } from "../../lib/projectScriptTerminal";
import { type TerminalContextSelection } from "../../lib/terminalContext";
import { focusActiveDrawerTerminal, focusTerminal } from "../../lib/terminalFocus";
import { useTerminalUiStateStore } from "../../terminalUiStateStore";
import {
  LAST_INVOKED_SCRIPT_BY_PROJECT_KEY,
  LastInvokedScriptByProjectSchema,
  makeThreadErrorSetter,
} from "../ChatView.logic";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { previewEnvironment } from "../../state/preview";
import { readEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import type { ChatShortcutCommands } from "./useChatShortcuts";
const SCRIPT_TERMINAL_COLS = 120;
const SCRIPT_TERMINAL_ROWS = 30;

interface ChatTerminalActionsInput {
  readonly environmentId: EnvironmentId;
  readonly composerRef: ComposerHandleRef;
  readonly terminalUiState: ReturnType<typeof selectThreadTerminalUiState>;
  readonly activeThread: EnvironmentThreadShell | undefined;
  readonly activeThreadId: ThreadId | null;
  readonly activeThreadRef: ScopedThreadRef | null;
  readonly activeProject: EnvironmentProject | null;
  readonly runningTerminalIds: ReadonlyArray<string>;
  readonly activeServerOrderedTerminalIds: ReadonlyArray<string>;
  readonly activeTerminalLabelsById: ReadonlyMap<string, string>;
  readonly panelTerminalIds: ReadonlySet<string>;
  readonly canReuseTerminal: boolean;
  readonly gitCwd: string | null;
  readonly setTerminalUiLaunchContext: Dispatch<SetStateAction<TerminalLaunchContext | null>>;
  readonly setThreadError: ReturnType<typeof makeThreadErrorSetter>;
}

/**
 * The thread's terminals: the drawer's and the right panel's, and project scripts and chat
 * code blocks, which run in a reused or new drawer terminal.
 */
export function useChatTerminalActions(input: ChatTerminalActionsInput) {
  const {
    environmentId,
    composerRef,
    terminalUiState,
    activeThread,
    activeThreadId,
    activeThreadRef,
    activeProject,
    runningTerminalIds,
    activeServerOrderedTerminalIds,
    activeTerminalLabelsById,
    panelTerminalIds,
    canReuseTerminal,
    gitCwd,
    setTerminalUiLaunchContext,
    setThreadError,
  } = input;
  const openPreview = useAtomCommand(previewEnvironment.open, { reportFailure: false });

  const hasTerminalWriteAccess = () =>
    readEnvironmentScope(environmentId, AuthTerminalOperateScope);
  const [lastInvokedScriptByProjectId, setLastInvokedScriptByProjectId] = useLocalStorage(
    LAST_INVOKED_SCRIPT_BY_PROJECT_KEY,
    {},
    LastInvokedScriptByProjectSchema,
  );
  const storeSetTerminalOpen = useTerminalUiStateStore((s) => s.setTerminalOpen);
  const storeEnsureTerminal = useTerminalUiStateStore((state) => state.ensureTerminal);
  const storeReconcileTerminalIds = useTerminalUiStateStore((state) => state.reconcileTerminalIds);
  const storeSplitTerminal = useTerminalUiStateStore((s) => s.splitTerminal);
  const storeSplitTerminalVertical = useTerminalUiStateStore((s) => s.splitTerminalVertical);
  const storeNewTerminal = useTerminalUiStateStore((s) => s.newTerminal);
  const storeCloseTerminal = useTerminalUiStateStore((s) => s.closeTerminal);
  const terminalActions = useThreadTerminalActions(activeThreadRef);

  const activeTerminalGroup =
    terminalUiState.terminalGroups.find(
      (group) => group.id === terminalUiState.activeTerminalGroupId,
    ) ??
    terminalUiState.terminalGroups.find((group) =>
      group.terminalIds.includes(terminalUiState.activeTerminalId),
    ) ??
    null;
  const hasReachedSplitLimit =
    (activeTerminalGroup?.terminalIds.length ?? 0) >= MAX_TERMINALS_PER_GROUP;
  const addTerminalContextToDraft = (selection: TerminalContextSelection) => {
    composerRef.current?.addTerminalContext(selection);
  };
  const addTerminalContextToDraftStable = useStableCallback(addTerminalContextToDraft);
  const setTerminalOpen = (open: boolean) => {
    if (!activeThreadRef) return;
    storeSetTerminalOpen(activeThreadRef, open);
    focusActiveDrawerTerminal(activeThreadRef);
  };
  const setTerminalOpenStable = useStableCallback(setTerminalOpen);
  const toggleTerminalVisibility = () => {
    if (!activeThreadRef) return;
    const nextOpen = !terminalUiState.terminalOpen;
    if (
      nextOpen &&
      !readEnvironmentScope(environmentId, AuthTerminalReadScope) &&
      !hasTerminalWriteAccess()
    )
      return;
    if (nextOpen && hasTerminalWriteAccess() && terminalUiState.terminalIds.length === 0) {
      // Reattach the thread's existing sessions before allocating another PTY.
      const existingTerminalIds = activeServerOrderedTerminalIds.filter(
        (terminalId) => !panelTerminalIds.has(terminalId),
      );
      if (existingTerminalIds.length > 0) {
        storeReconcileTerminalIds(activeThreadRef, existingTerminalIds);
      }
      // A server-created setup terminal may arrive before the ordered session list.
      const existingTerminalId =
        runningTerminalIds.find((id) => !panelTerminalIds.has(id)) ?? existingTerminalIds[0];
      if (existingTerminalId !== undefined) {
        storeEnsureTerminal(activeThreadRef, existingTerminalId, { open: true, active: true });
        focusActiveDrawerTerminal(activeThreadRef);
        return;
      }
      void terminalActions.launchTerminal({
        place: (terminalId) => storeEnsureTerminal(activeThreadRef, terminalId, { open: true }),
      })?.result;
      focusActiveDrawerTerminal(activeThreadRef);
      return;
    }
    setTerminalOpen(nextOpen);
  };
  const toggleTerminalVisibilityStable = useStableCallback(toggleTerminalVisibility);
  const splitTerminal = (direction: "horizontal" | "vertical" = "horizontal") => {
    if (!activeThreadRef || hasReachedSplitLimit) return;
    const launched = terminalActions.launchTerminal({
      place: (terminalId) =>
        direction === "vertical"
          ? storeSplitTerminalVertical(activeThreadRef, terminalId)
          : storeSplitTerminal(activeThreadRef, terminalId),
    });
    if (!launched) return;
    focusTerminal(activeThreadRef, launched.terminalId);
    void launched.result;
  };
  const splitTerminalStable = useStableCallback(splitTerminal);
  const startTerminal = (show: (threadRef: ScopedThreadRef, terminalId: string) => void) => {
    if (!hasTerminalWriteAccess() || !activeThreadRef) return;
    const launched = terminalActions.launchTerminal({
      place: (terminalId) => show(activeThreadRef, terminalId),
    });
    if (!launched) return;
    focusTerminal(activeThreadRef, launched.terminalId);
    void launched.result;
  };
  const createNewTerminal = () =>
    startTerminal((threadRef, terminalId) => {
      storeNewTerminal(threadRef, terminalId);
    });
  const createNewTerminalStable = useStableCallback(createNewTerminal);
  const closeTerminal = (terminalId: string) => {
    if (!hasTerminalWriteAccess() || !activeThreadRef) return;
    terminalActions.closeTerminalSession(terminalId, activeThreadRef);
    storeCloseTerminal(activeThreadRef, terminalId);
    focusActiveDrawerTerminal(activeThreadRef);
  };
  const runProjectScript = async (
    script: ProjectScript,
    options?: {
      cwd?: string;
      env?: Record<string, string>;
      worktreePath?: string | null;
      preferNewTerminal?: boolean;
      rememberAsLastInvoked?: boolean;
      shellHistory?: "preserve" | "suppress";
    },
  ) => {
    if (!hasTerminalWriteAccess() || !activeThreadId || !activeProject || !activeThread) return;
    if (options?.rememberAsLastInvoked !== false) {
      setLastInvokedScriptByProjectId((current) => {
        if (current[activeProject.id] === script.id) return current;
        return { ...current, [activeProject.id]: script.id };
      });
    }
    const targetCwd = options?.cwd ?? gitCwd ?? activeProject.workspaceRoot;
    const reusableTerminalId =
      options?.preferNewTerminal ||
      !canReuseTerminal ||
      !readEnvironmentScope(environmentId, AuthTerminalReadScope)
        ? null
        : findReusableProjectScriptTerminal({
            // Server sessions cover drawer terminals this client has not opened yet, such as a
            // worktree setup shell; the helper drops the panel-owned ones.
            drawerTerminalIds: [
              ...new Set([...terminalUiState.terminalIds, ...activeServerOrderedTerminalIds]),
            ],
            activeTerminalId: terminalUiState.activeTerminalId,
            panelTerminalIds,
            runningTerminalIds,
          });
    const targetWorktreePath = options?.worktreePath ?? activeThread.worktreePath ?? null;

    setTerminalUiLaunchContext({
      threadId: activeThreadId,
      cwd: targetCwd,
      worktreePath: targetWorktreePath,
    });
    if (!activeThreadRef) {
      return;
    }

    const launched = terminalActions.launchTerminal({
      // The drawer opens with the target already placed: opening it empty would claim
      // DEFAULT_THREAD_TERMINAL_ID, which a right-panel terminal may already own.
      place: (terminalId) =>
        reusableTerminalId === null
          ? storeNewTerminal(activeThreadRef, terminalId)
          : storeEnsureTerminal(activeThreadRef, terminalId, { open: true }),
      ...(reusableTerminalId === null
        ? { size: { cols: SCRIPT_TERMINAL_COLS, rows: SCRIPT_TERMINAL_ROWS } }
        : { terminalId: reusableTerminalId }),
      location: { cwd: targetCwd, worktreePath: targetWorktreePath },
      ...(options?.env ? { extraEnv: options.env } : {}),
    });
    if (!launched) return;
    const targetTerminalId = launched.terminalId;
    focusTerminal(activeThreadRef, targetTerminalId);
    const openResult = await launched.result;
    if (openResult._tag === "Failure") {
      if (!isAtomCommandInterrupted(openResult)) {
        const error = squashAtomCommandFailure(openResult);
        setThreadError(
          activeThreadId,
          error instanceof Error ? error.message : `Failed to run script "${script.name}".`,
        );
      }
      return;
    }

    const writeResult = await terminalActions.writeToTerminal(
      targetTerminalId,
      options?.shellHistory === "preserve"
        ? `${script.command}\r`
        : projectScriptTerminalInput(script.command),
    );
    if (!writeResult) return;
    if (writeResult._tag === "Failure") {
      if (!isAtomCommandInterrupted(writeResult)) {
        const error = squashAtomCommandFailure(writeResult);
        setThreadError(
          activeThreadId,
          error instanceof Error ? error.message : `Failed to run script "${script.name}".`,
        );
      }
      return;
    }
    if (script.autoOpenPreview && script.previewUrl && isPreviewSupportedInRuntime()) {
      const previewResult = await openUrlInPreview({
        threadRef: activeThreadRef,
        url: resolveDiscoveredServerUrl(activeThreadRef.environmentId, script.previewUrl),
        openPreview,
      });
      if (previewResult._tag === "Failure" && !isAtomCommandInterrupted(previewResult)) {
        const error = squashAtomCommandFailure(previewResult);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not open preview",
            description: error instanceof Error ? error.message : "An unexpected error occurred.",
          }),
        );
      }
    }
  };
  const runProjectScriptStable = useStableCallback(runProjectScript);

  const runShellCommand = (command: string) => {
    void runProjectScript(
      {
        id: "chat-code-block",
        name: "Chat code block",
        command,
        icon: "play",
        runOnWorktreeCreate: false,
      },
      { rememberAsLastInvoked: false, shellHistory: "preserve" },
    );
  };
  const runShellCommandStable = useStableCallback(runShellCommand);
  const requestCloseTerminal = (terminalId: string) => {
    if (!hasTerminalWriteAccess()) return;
    const label = activeTerminalLabelsById.get(terminalId) ?? getTerminalLabel(terminalId);
    void confirmTerminalClose([label]).then((confirmed) => {
      if (confirmed && readEnvironmentScope(environmentId, AuthTerminalOperateScope)) {
        closeTerminal(terminalId);
      }
    });
  };
  const requestCloseTerminalStable = useStableCallback(requestCloseTerminal);
  const openTerminalIfClosed = () => {
    if (!terminalUiState.terminalOpen) setTerminalOpen(true);
  };
  // Surface tabs own their terminal chords; this hook handles the chat's terminal pane.
  const shortcuts = {
    "terminal.toggle": () => {
      if (
        !terminalUiState.terminalOpen &&
        !readEnvironmentScope(environmentId, AuthTerminalReadScope) &&
        !hasTerminalWriteAccess()
      )
        return false;
      if (activeThreadRef === null) return false;
      toggleThreadTerminalPane(activeThreadRef, () => {
        if (!terminalUiState.terminalOpen) toggleTerminalVisibilityStable();
      });
    },
    "terminal.split": ({ terminalFocusOwner }) => {
      if (terminalFocusOwner !== null || !hasTerminalWriteAccess()) return false;
      openTerminalIfClosed();
      splitTerminal();
    },
    "terminal.splitVertical": ({ terminalFocusOwner }) => {
      if (terminalFocusOwner !== null || !hasTerminalWriteAccess()) return false;
      openTerminalIfClosed();
      splitTerminal("vertical");
    },
    "terminal.close": ({ event, terminalFocusOwner }) => {
      if (terminalFocusOwner !== null || !hasTerminalWriteAccess()) return false;
      if (!event.repeat && terminalUiState.terminalOpen)
        requestCloseTerminal(terminalUiState.activeTerminalId);
    },
    "terminal.new": ({ terminalFocusOwner }) => {
      if (terminalFocusOwner !== null || !hasTerminalWriteAccess()) return false;
      openTerminalIfClosed();
      createNewTerminal();
    },
  } satisfies ChatShortcutCommands;
  return {
    shortcuts,
    startTerminal,
    addTerminalContextToDraftStable,
    createNewTerminalStable,
    lastInvokedScriptByProjectId,
    requestCloseTerminalStable,
    runProjectScriptStable,
    runShellCommandStable,
    setTerminalOpenStable,
    splitTerminalStable,
    toggleTerminalVisibilityStable,
  };
}
