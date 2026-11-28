import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { msg } from "gt-react";
import { m } from "~/i18n/messages";
import {
  AuthTerminalOperateScope,
  AuthTerminalReadScope,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { projectScriptCwd, projectScriptRuntimeEnv } from "@t3tools/shared/projectScripts";
import { nextTerminalId } from "@t3tools/shared/terminalLabels";
import { useComposerDraftStore } from "../../composerDraftStore";
import { useStableCallback } from "../../hooks/useStableCallback";
import { randomUUID } from "~/lib/utils";
import {
  rightPanelHostRef,
  selectThreadRightPanelState,
  useRightPanelStore,
} from "../../rightPanelStore";
import { useProject, useQuietThreadShell } from "../../state/entities";
import { readEnvironmentScope } from "../../state/session";
import { terminalEnvironment } from "../../state/terminal";
import { useKnownTerminalSessions } from "../../state/terminalSessions";
import { useAtomCommand } from "../../state/use-atom-command";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../../terminalUiStateStore";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { closingTerminalIds, holdTerminalIdWhileClosing } from "./closingTerminals";

/** Where a new terminal starts. Omitted fields fall back to the thread's project and worktree. */
export interface TerminalLaunchLocation {
  readonly cwd: string;
  readonly worktreePath: string | null;
}

/** Allocate terminal ids and launch locations centrally so all surfaces share one view of sessions. */
export function useThreadTerminalActions(threadRef: ScopedThreadRef | null) {
  const openTerminalCommand = useAtomCommand(terminalEnvironment.open, "terminal open");
  const writeTerminal = useAtomCommand(terminalEnvironment.write, "terminal write");
  const closeTerminalCommand = useAtomCommand(terminalEnvironment.close, "terminal close");
  const serverThread = useQuietThreadShell(threadRef);
  const draftThread = useComposerDraftStore((store) =>
    threadRef ? store.getDraftThreadByRef(threadRef) : null,
  );
  const projectRef = serverThread
    ? scopeProjectRef(serverThread.environmentId, serverThread.projectId)
    : draftThread
      ? scopeProjectRef(draftThread.environmentId, draftThread.projectId)
      : null;
  const project = useProject(projectRef);
  const threadWorktreePath = serverThread?.worktreePath ?? draftThread?.worktreePath ?? null;
  const knownSessions = useKnownTerminalSessions({
    environmentId: threadRef?.environmentId ?? null,
    threadId: threadRef?.threadId ?? null,
  });
  const canWrite = () =>
    threadRef !== null && readEnvironmentScope(threadRef.environmentId, AuthTerminalOperateScope);

  // Server lists lag and colliding ids share a PTY; without read access, suffix ids to avoid unseen sessions.
  const allocateTerminalId = (panelRef: ScopedThreadRef) => {
    const drawer = selectThreadTerminalUiState(
      useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
      threadRef,
    );
    const panel = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, panelRef);
    const ids = new Set([
      ...(knownSessions ?? []).map((session) => session.target.terminalId),
      ...drawer.terminalIds,
      ...panel.surfaces.flatMap((surface) =>
        surface.kind === "terminal" ? surface.terminalIds : [],
      ),
      ...(threadRef ? closingTerminalIds(threadRef) : []),
    ]);
    const canReuse =
      knownSessions !== null &&
      threadRef !== null &&
      readEnvironmentScope(threadRef.environmentId, AuthTerminalReadScope);
    return nextTerminalId([...ids], canReuse ? undefined : randomUUID());
  };

  const defaultLaunchLocation = (): TerminalLaunchLocation | null =>
    project
      ? {
          cwd: projectScriptCwd({
            project: { cwd: project.workspaceRoot },
            worktreePath: threadWorktreePath,
          }),
          worktreePath: threadWorktreePath,
        }
      : null;

  /** place mounts the destination before the server open resolves. */
  const launchTerminal = (input: {
    readonly place: (terminalId: string) => void | (() => void);
    readonly reportRejection?: boolean;
    readonly terminalId?: string;
    readonly location?: TerminalLaunchLocation | null;
    readonly extraEnv?: Record<string, string>;
    readonly stopOnSettle?: boolean;
    readonly size?: { readonly cols: number; readonly rows: number };
  }) => {
    if (!threadRef || !canWrite() || !project) return null;
    const location = input.location ?? defaultLaunchLocation();
    if (!location) return null;
    const panelRef = rightPanelHostRef(threadRef);
    const terminalId = input.terminalId ?? allocateTerminalId(panelRef);
    const onOpened = input.place(terminalId);
    const result = openTerminalCommand({
      environmentId: threadRef.environmentId,
      input: {
        threadId: threadRef.threadId,
        terminalId,
        cwd: location.cwd,
        ...(location.worktreePath !== null ? { worktreePath: location.worktreePath } : {}),
        env: projectScriptRuntimeEnv({
          project: { cwd: project.workspaceRoot },
          worktreePath: location.worktreePath,
          ...(input.extraEnv ? { extraEnv: input.extraEnv } : {}),
        }),
        ...input.size,
        ...(input.stopOnSettle !== undefined ? { stopOnSettle: input.stopOnSettle } : {}),
      },
    }).then((outcome) => {
      if (outcome._tag === "Success") {
        onOpened?.();
      } else if (!isAtomCommandInterrupted(outcome)) {
        // A supplied ID refers to a reusable session. A rejected reopen does not delete it.
        if (input.terminalId === undefined) {
          useTerminalUiStateStore.getState().discardTerminalPlacement(threadRef, terminalId);
          const panel = useRightPanelStore.getState();
          const surface = selectThreadRightPanelState(panel.byThreadKey, panelRef).surfaces.find(
            (entry) => entry.kind === "terminal" && entry.terminalIds.includes(terminalId),
          );
          if (surface) panel.closeTerminal(panelRef, surface.id, terminalId);
        }
        if (input.reportRejection !== false) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title:
                thrownErrorMessage(squashAtomCommandFailure(outcome), m) ||
                m(msg("An unexpected error occurred.")),
            }),
          );
        }
      }
      return outcome;
    });
    return { terminalId, result };
  };

  const launchSplitTerminal = (input: {
    readonly direction: "horizontal" | "vertical";
    readonly surfaceId?: string;
    readonly location?: TerminalLaunchLocation;
  }) => {
    if (!threadRef) return null;
    const { direction, surfaceId, location } = input;
    return launchTerminal({
      ...(location === undefined ? {} : { location }),
      place: (terminalId) => {
        // Mount the new pane immediately. Keep the surviving panes' layout until the open succeeds.
        if (surfaceId !== undefined) {
          const panel = useRightPanelStore.getState();
          const panelRef = rightPanelHostRef(threadRef);
          panel.splitTerminal(threadRef, surfaceId, terminalId, null);
          return () => panel.setTerminalSplitDirection(panelRef, surfaceId, terminalId, direction);
        }
        const drawer = useTerminalUiStateStore.getState();
        drawer.splitTerminal(threadRef, terminalId, null);
        return () => drawer.setSplitDirection(threadRef, terminalId, direction);
      },
    });
  };

  /** Ends a session and deletes its history. A failed close falls back to typing `exit`. */
  const closeTerminalSession = (terminalId: string, target = threadRef) => {
    if (!target || !readEnvironmentScope(target.environmentId, AuthTerminalOperateScope)) return;
    const environmentId = target.environmentId;
    const threadId = target.threadId;
    void holdTerminalIdWhileClosing(target, terminalId, async () => {
      const closeResult = await closeTerminalCommand({
        environmentId,
        input: { threadId, terminalId, deleteHistory: true },
      });
      if (
        closeResult._tag === "Failure" &&
        !isAtomCommandInterrupted(closeResult) &&
        readEnvironmentScope(environmentId, AuthTerminalOperateScope)
      ) {
        await writeTerminal({ environmentId, input: { threadId, terminalId, data: "exit\n" } });
      }
    });
  };

  const writeToTerminal = (terminalId: string, data: string) => {
    if (!threadRef || !canWrite()) return null;
    return writeTerminal({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, terminalId, data },
    });
  };

  return {
    canWrite: useStableCallback(canWrite),
    launchTerminal: useStableCallback(launchTerminal),
    launchSplitTerminal: useStableCallback(launchSplitTerminal),
    closeTerminalSession: useStableCallback(closeTerminalSession),
    writeToTerminal: useStableCallback(writeToTerminal),
  };
}
