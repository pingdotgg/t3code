import {
  AuthTerminalOperateScope,
  AuthTerminalReadScope,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import { projectScriptCwd, projectScriptRuntimeEnv } from "@t3tools/shared/projectScripts";
import { nextTerminalId } from "@t3tools/shared/terminalLabels";
import { useComposerDraftStore } from "../../composerDraftStore";
import { useStableCallback } from "../../hooks/useStableCallback";
import { randomUUID } from "~/lib/utils";
import { selectThreadRightPanelState, useRightPanelStore } from "../../rightPanelStore";
import { useProject, useThreadShell } from "../../state/entities";
import { readEnvironmentScope } from "../../state/session";
import { terminalEnvironment } from "../../state/terminal";
import { useKnownTerminalSessions } from "../../state/terminalSessions";
import { useAtomCommand } from "../../state/use-atom-command";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../../terminalUiStateStore";

/** Where a new terminal starts. Omitted fields fall back to the thread's project and worktree. */
export interface TerminalLaunchLocation {
  readonly cwd: string;
  readonly worktreePath: string | null;
}

/**
 * Opens and closes a thread's terminal sessions. Every surface that hosts a
 * terminal (the drawer, a right panel tab, the setup flow, script runs) goes
 * through here, so ids are allocated from one view of the thread's terminals
 * and every new session starts with the same cwd and environment.
 */
export function useThreadTerminalActions(threadRef: ScopedThreadRef | null) {
  const openTerminalCommand = useAtomCommand(terminalEnvironment.open, "terminal open");
  const writeTerminal = useAtomCommand(terminalEnvironment.write, "terminal write");
  const closeTerminalCommand = useAtomCommand(terminalEnvironment.close, "terminal close");
  const serverThread = useThreadShell(threadRef);
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
  const drawerTerminalIds = useTerminalUiStateStore(
    (state) => selectThreadTerminalUiState(state.terminalUiStateByThreadKey, threadRef).terminalIds,
  );
  const panelSurfaces = useRightPanelStore(
    (state) => selectThreadRightPanelState(state.byThreadKey, threadRef).surfaces,
  );

  const canWrite = () =>
    threadRef !== null && readEnvironmentScope(threadRef.environmentId, AuthTerminalOperateScope);

  // Every client-side id source participates: the server list lags fresh opens,
  // and an id collision attaches two viewports to one PTY session. Without a
  // readable session list the next free number may already be taken on the
  // server, so the id gets a unique suffix.
  const allocateTerminalId = () => {
    const ids = new Set([
      ...(knownSessions ?? []).map((session) => session.target.terminalId),
      ...drawerTerminalIds,
      ...panelSurfaces.flatMap((surface) =>
        surface.kind === "terminal" ? surface.terminalIds : [],
      ),
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

  /**
   * Starts a session for `terminalId` on the server. `place` records the id in
   * the surface that will show it, before the open resolves, so the viewport
   * mounts while the session starts.
   */
  const launchTerminal = (input: {
    readonly place: (terminalId: string) => void;
    readonly terminalId?: string;
    readonly location?: TerminalLaunchLocation | null;
    readonly extraEnv?: Record<string, string>;
    readonly size?: { readonly cols: number; readonly rows: number };
  }) => {
    if (!threadRef || !canWrite() || !project) return null;
    const location = input.location ?? defaultLaunchLocation();
    if (!location) return null;
    const terminalId = input.terminalId ?? allocateTerminalId();
    input.place(terminalId);
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
      },
    });
    return { terminalId, result };
  };

  /** Ends a session and deletes its history. A failed close falls back to typing `exit`. */
  const closeTerminalSession = (terminalId: string) => {
    if (!threadRef || !canWrite()) return;
    const environmentId = threadRef.environmentId;
    const threadId = threadRef.threadId;
    void (async () => {
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
    })();
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
    allocateTerminalId: useStableCallback(allocateTerminalId),
    launchTerminal: useStableCallback(launchTerminal),
    closeTerminalSession: useStableCallback(closeTerminalSession),
    writeToTerminal: useStableCallback(writeToTerminal),
  };
}
