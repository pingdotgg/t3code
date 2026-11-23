import { msg } from "gt-react";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { m } from "~/i18n/messages";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import type { Dispatch } from "react";
import type { ComposerHandleRef } from "../../composerHandleContext";
import { useStableCallback } from "../../hooks/useStableCallback";
import { useThreadTerminalActions } from "../terminal/useThreadTerminalActions";
import { getTerminalLabel } from "@t3tools/shared/terminalLabelsCopy";
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
import {
  selectActiveTerminalSurface,
  selectTerminalDrawerVisible,
  selectThreadRightPanelState,
  useRightPanelStore,
} from "../../rightPanelStore";
import { openUrlInPreview } from "../../browser/openFileInPreview";
import { isPreviewAvailableFor } from "../../browser/previewRuntime";
import { resolveDiscoveredServerUrl } from "../../browser/browserTargetResolver";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { confirmTerminalClose } from "../../lib/terminalCloseConfirm";
import { findReusableProjectScriptTerminal } from "../../lib/projectScriptTerminal";
import { closingTerminalIds } from "../terminal/closingTerminals";
import { type TerminalContextSelection } from "../../lib/terminalContext";
import { focusActivePanelTerminal, focusTerminal } from "../../lib/terminalFocus";
import { requestWorkspaceFocus } from "../../lib/workspaceFocus";
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

export interface TerminalLaunchContext {
  threadId: ThreadId;
  cwd: string;
  worktreePath: string | null;
}

interface ChatTerminalActionsInput {
  readonly environmentId: EnvironmentId;
  readonly composerRef: ComposerHandleRef;
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
 * The thread's terminals in the right panel's drawer, and project scripts and chat code
 * blocks, which run in a reused or new drawer terminal.
 */
export function useChatTerminalActions(input: ChatTerminalActionsInput) {
  const {
    environmentId,
    composerRef,
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
  const terminalActions = useThreadTerminalActions(activeThreadRef);

  const addTerminalContextToDraft = (selection: TerminalContextSelection) => {
    composerRef.current?.addTerminalContext(selection);
  };
  const addTerminalContextToDraftStable = useStableCallback(addTerminalContextToDraft);
  const addTerminalSurface = () => {
    if (!activeThreadRef) return;
    const launched = terminalActions.launchTerminal({
      place: (terminalId) =>
        useRightPanelStore.getState().openTerminal(activeThreadRef, terminalId),
    });
    if (!launched) return;
    focusTerminal(activeThreadRef, launched.terminalId);
    void launched.result;
  };
  const addTerminalSurfaceStable = useStableCallback(addTerminalSurface);
  const drawerTerminalSurface = () =>
    selectActiveTerminalSurface(useRightPanelStore.getState().byThreadKey, activeThreadRef);
  /**
   * Shows or hides the right panel's terminal drawer, opening the panel when needed. A thread
   * with no terminal reuses a server session no sub-tab owns, else launches exactly one.
   */
  const toggleTerminalDrawer = () => {
    if (!activeThreadRef) return;
    const store = useRightPanelStore.getState();
    if (selectTerminalDrawerVisible(store, activeThreadRef)) {
      store.setTerminalDrawerOpen(activeThreadRef, false);
      return;
    }
    if (!readEnvironmentScope(environmentId, AuthTerminalReadScope) && !hasTerminalWriteAccess())
      return;
    const hasTerminal = selectThreadRightPanelState(
      store.byThreadKey,
      activeThreadRef,
    ).surfaces.some((surface) => surface.kind === "terminal");
    if (!hasTerminal && hasTerminalWriteAccess()) {
      // The server lists a closing terminal until its close finishes, which would end the reopen.
      const closingIds = new Set(closingTerminalIds(activeThreadRef));
      const isReusable = (id: string) => !panelTerminalIds.has(id) && !closingIds.has(id);
      const existingTerminalId =
        runningTerminalIds.find(isReusable) ?? activeServerOrderedTerminalIds.find(isReusable);
      if (existingTerminalId !== undefined) {
        store.openTerminal(activeThreadRef, existingTerminalId);
        focusTerminal(activeThreadRef, existingTerminalId);
        requestWorkspaceFocus({ area: "terminal" });
        return;
      }
      addTerminalSurface();
    }
    // Also when no shell could start, so the drawer shows why instead of nothing happening.
    store.setTerminalDrawerOpen(activeThreadRef, true);
    focusActivePanelTerminal(activeThreadRef);
    // Opening the panel requests focus for its default, the launcher when it has no tool.
    requestWorkspaceFocus({ area: "terminal" });
  };
  const toggleTerminalDrawerStable = useStableCallback(toggleTerminalDrawer);
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
      script.stopOnSettle ||
      options?.preferNewTerminal ||
      !canReuseTerminal ||
      !readEnvironmentScope(environmentId, AuthTerminalReadScope)
        ? null
        : findReusableProjectScriptTerminal({
            // Server sessions cover terminals this client has not adopted yet, such as a
            // worktree setup shell.
            drawerTerminalIds: [
              ...new Set([...panelTerminalIds, ...activeServerOrderedTerminalIds]),
            ],
            activeTerminalId: drawerTerminalSurface()?.activeTerminalId ?? "",
            panelTerminalIds: new Set(),
            runningTerminalIds,
            closingTerminalIds: activeThreadRef ? closingTerminalIds(activeThreadRef) : [],
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
      place: (terminalId) =>
        useRightPanelStore.getState().openTerminal(activeThreadRef, terminalId),
      ...(reusableTerminalId === null
        ? { size: { cols: SCRIPT_TERMINAL_COLS, rows: SCRIPT_TERMINAL_ROWS } }
        : { terminalId: reusableTerminalId }),
      location: { cwd: targetCwd, worktreePath: targetWorktreePath },
      stopOnSettle: script.stopOnSettle ?? false,
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
          thrownErrorMessage(error, m) ??
            m(msg('Failed to run script "{name}".', { name: script.name })),
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
          thrownErrorMessage(error, m) ??
            m(msg('Failed to run script "{name}".', { name: script.name })),
        );
      }
      return;
    }
    if (
      script.autoOpenPreview &&
      script.previewUrl &&
      isPreviewAvailableFor(activeThreadRef.environmentId)
    ) {
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
            title: m(msg("Could not open preview")),
            description: thrownErrorMessage(error, m) ?? m(msg("An unexpected error occurred.")),
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
        name: m(msg("Chat code block")),
        command,
        icon: "play",
        runOnWorktreeCreate: false,
      },
      { rememberAsLastInvoked: false, shellHistory: "preserve" },
    );
  };
  const runShellCommandStable = useStableCallback(runShellCommand);
  const splitPanelTerminal = (direction: "horizontal" | "vertical" = "horizontal") => {
    const surface = drawerTerminalSurface();
    if (!activeThreadRef || !surface || surface.terminalIds.length >= MAX_TERMINALS_PER_GROUP) {
      return;
    }
    const surfaceId = surface.id;
    const launched = terminalActions.launchTerminal({
      place: (terminalId) =>
        useRightPanelStore
          .getState()
          .splitTerminal(activeThreadRef, surfaceId, terminalId, direction),
    });
    if (!launched) return;
    focusTerminal(activeThreadRef, launched.terminalId);
    void launched.result;
  };
  const splitPanelTerminalStable = useStableCallback(splitPanelTerminal);
  const splitPanelTerminalVertical = () => {
    splitPanelTerminal("vertical");
  };
  const splitPanelTerminalVerticalStable = useStableCallback(splitPanelTerminalVertical);
  const activatePanelTerminal = (terminalId: string) => {
    const surface = drawerTerminalSurface();
    if (!activeThreadRef || !surface) return;
    useRightPanelStore.getState().activateTerminal(activeThreadRef, surface.id, terminalId);
    focusTerminal(activeThreadRef, terminalId);
  };
  const activatePanelTerminalStable = useStableCallback(activatePanelTerminal);
  const closePanelTerminal = (terminalId: string, target = activeThreadRef) => {
    if (!target || !readEnvironmentScope(target.environmentId, AuthTerminalOperateScope)) return;
    const store = useRightPanelStore.getState();
    const surface = selectThreadRightPanelState(store.byThreadKey, target).surfaces.find(
      (entry) => entry.kind === "terminal" && entry.terminalIds.includes(terminalId),
    );
    if (!surface) return;
    terminalActions.closeTerminalSession(terminalId, target);
    store.closeTerminal(target, surface.id, terminalId);
    // A shell exiting in a hidden thread's drawer must not take focus here.
    if (activeThreadRef && scopedThreadKey(target) === scopedThreadKey(activeThreadRef)) {
      focusActivePanelTerminal(target);
    }
  };
  const closePanelTerminalStable = useStableCallback(closePanelTerminal);
  const requestClosePanelTerminal = (terminalId: string) => {
    if (!hasTerminalWriteAccess()) return;
    const label = activeTerminalLabelsById.get(terminalId) ?? getTerminalLabel(terminalId, m);
    void confirmTerminalClose([label]).then((confirmed) => {
      if (confirmed && readEnvironmentScope(environmentId, AuthTerminalOperateScope)) {
        closePanelTerminal(terminalId);
      }
    });
  };
  // Outside a focused terminal, split falls back to a new terminal when the drawer has none.
  const splitOrCreateTerminal = (direction: "horizontal" | "vertical") => {
    if (drawerTerminalSurface()) splitPanelTerminal(direction);
    else addTerminalSurface();
  };
  const shortcuts = {
    "terminal.toggle": () => {
      if (!readEnvironmentScope(environmentId, AuthTerminalReadScope) && !hasTerminalWriteAccess())
        return false;
      toggleTerminalDrawer();
    },
    "terminal.split": () => {
      if (!hasTerminalWriteAccess()) return false;
      splitOrCreateTerminal("horizontal");
    },
    "terminal.splitVertical": () => {
      if (!hasTerminalWriteAccess()) return false;
      splitOrCreateTerminal("vertical");
    },
    "terminal.close": ({ terminalFocusOwner }) => {
      if (!hasTerminalWriteAccess()) return false;
      const panelSurface = drawerTerminalSurface();
      if (!panelSurface) return;
      if (
        terminalFocusOwner === "right-panel" ||
        (activeThreadRef !== null &&
          selectTerminalDrawerVisible(useRightPanelStore.getState(), activeThreadRef))
      ) {
        requestClosePanelTerminal(panelSurface.activeTerminalId);
      }
    },
    "terminal.new": () => {
      if (!hasTerminalWriteAccess()) return false;
      addTerminalSurface();
    },
  } satisfies ChatShortcutCommands;
  return {
    shortcuts,
    activatePanelTerminalStable,
    addTerminalContextToDraftStable,
    addTerminalSurfaceStable,
    closePanelTerminalStable,
    lastInvokedScriptByProjectId,
    runProjectScriptStable,
    runShellCommandStable,
    splitPanelTerminalStable,
    splitPanelTerminalVerticalStable,
    toggleTerminalDrawerStable,
  };
}
