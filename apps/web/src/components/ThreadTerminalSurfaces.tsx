/**
 * A thread's terminals as layout tabs: the thread's terminal (cmd+J), with
 * its groups and splits, and a terminal surface opened from a launcher or a
 * surface's "+". Each takes its thread and works out its own context, so the
 * tab shows it whether or not the thread's chat is open.
 */
import {
  AuthTerminalReadScope,
  AuthTerminalOperateScope,
  type EnvironmentId,
  type ResolvedKeybindingsConfig,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import {
  resolveTerminalActivityStatus,
  type TerminalActivityStatus,
} from "@t3tools/client-runtime/state/terminal";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { projectScriptCwd, projectScriptRuntimeEnv } from "@t3tools/shared/projectScripts";
import { nextTerminalId, resolveTerminalSessionLabel } from "@t3tools/shared/terminalLabels";
import { memo, useEffect } from "react";
import { focusActiveDrawerTerminal, focusTerminal } from "../lib/terminalFocus";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import {
  selectThreadRightPanelState,
  type RightPanelSurface,
  useRightPanelStore,
} from "../rightPanelStore";
import ThreadTerminalDrawer from "./ThreadTerminalDrawer";
import { resolveTerminalWorktreePath } from "./ChatView.logic";
import { cn, randomUUID } from "~/lib/utils";
import { useComposerDraftStore } from "../composerDraftStore";
import { type TerminalContextSelection } from "../lib/terminalContext";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../terminalUiStateStore";
import { useKnownTerminalSessions } from "../state/terminalSessions";
import { useEnvironmentScope, useEnvironmentSessionLoaded } from "~/state/session";
import { terminalEnvironment } from "../state/terminal";
import { useProject, useQuietThreadShell } from "../state/entities";
import { threadlessSurfacesProjectRef, useThreadlessHome } from "../threadlessSurfaces";
import { readEnvironmentScope } from "../state/session";
import { useAtomCommand } from "../state/use-atom-command";
import { MAX_TERMINALS_PER_GROUP } from "../types";

export interface TerminalLaunchContext {
  threadId: ThreadId;
  cwd: string;
  worktreePath: string | null;
}

export type PersistentTerminalLaunchContext = Pick<TerminalLaunchContext, "cwd" | "worktreePath">;

/** A shell's env: its project's script variables, or none in the server's home. */
function shellRuntimeEnv(
  project: { readonly workspaceRoot: string } | null,
  worktreePath: string | null,
): Record<string, string> {
  return project
    ? projectScriptRuntimeEnv({ project: { cwd: project.workspaceRoot }, worktreePath })
    : {};
}
function terminalIdListsEqual(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  if (left.length === 0) {
    return true;
  }
  const sortedLeft = left.toSorted((a, b) => a.localeCompare(b));
  const sortedRight = right.toSorted((a, b) => a.localeCompare(b));
  for (let index = 0; index < sortedLeft.length; index += 1) {
    if (sortedLeft[index] !== sortedRight[index]) {
      return false;
    }
  }
  return true;
}

/**
 * Typical right after `terminal.open`: known-session list lags; reconciling would drop the new id
 * and later re-add it as a separate group (no split layout).
 */
function serverTerminalIdsStrictSubsetOfClient(
  serverIds: readonly string[],
  clientIds: readonly string[],
): boolean {
  if (serverIds.length >= clientIds.length || clientIds.length === 0) {
    return false;
  }
  const clientSet = new Set(clientIds);
  for (const id of serverIds) {
    if (!clientSet.has(id)) {
      return false;
    }
  }
  return true;
}

interface PersistentThreadTerminalDrawerProps {
  threadRef: { environmentId: EnvironmentId; threadId: ThreadId };
  threadId: ThreadId;
  active: boolean;
  launchContext: PersistentTerminalLaunchContext | null;
  splitShortcutLabel: string | undefined;
  splitVerticalShortcutLabel: string | undefined;
  newShortcutLabel: string | undefined;
  closeShortcutLabel: string | undefined;
  keybindings: ResolvedKeybindingsConfig;
  onAddTerminalContext:
    | ((selection: TerminalContextSelection) => void | Promise<boolean>)
    | undefined;
  /** As a layout tab the terminal fills its pane (cmd+J), not a drawer. */
  paneMode: boolean;
}

export const PersistentThreadTerminalDrawer = memo(function PersistentThreadTerminalDrawer({
  threadRef,
  threadId,
  active,
  launchContext,
  splitShortcutLabel,
  splitVerticalShortcutLabel,
  newShortcutLabel,
  closeShortcutLabel,
  keybindings,
  onAddTerminalContext,
  paneMode,
}: PersistentThreadTerminalDrawerProps) {
  const canOperateTerminal = useEnvironmentScope(threadRef.environmentId, AuthTerminalOperateScope);
  const hasTerminalWriteAccess = () =>
    readEnvironmentScope(threadRef.environmentId, AuthTerminalOperateScope);
  const openTerminal = useAtomCommand(terminalEnvironment.open, "terminal open");
  const writeTerminal = useAtomCommand(terminalEnvironment.write, "terminal write");
  const closeTerminalMutation = useAtomCommand(terminalEnvironment.close, "terminal close");
  const serverThread = useQuietThreadShell(threadRef);
  const draftThread = useComposerDraftStore((store) => store.getDraftThreadByRef(threadRef));
  const projectRef = serverThread
    ? scopeProjectRef(serverThread.environmentId, serverThread.projectId)
    : draftThread
      ? scopeProjectRef(draftThread.environmentId, draftThread.projectId)
      : threadlessSurfacesProjectRef(threadRef);
  const project = useProject(projectRef);
  // Shells open in its project's root, or a project-less threadless ref's server home.
  const home = useThreadlessHome(threadRef);
  const root = project?.workspaceRoot ?? home;
  const terminalUiState = useTerminalUiStateStore((state) =>
    selectThreadTerminalUiState(state.terminalUiStateByThreadKey, threadRef),
  );
  const visible = active && terminalUiState.terminalOpen;
  const knownTerminalSessions = useKnownTerminalSessions({
    environmentId: threadRef.environmentId,
    threadId,
  });
  // Until the grant and the session list load, which terminals exist is not known yet.
  const canReadTerminal = useEnvironmentScope(threadRef.environmentId, AuthTerminalReadScope);
  const sessionLoaded = useEnvironmentSessionLoaded(threadRef.environmentId);
  const attaching = !sessionLoaded || (canReadTerminal && knownTerminalSessions === null);
  const panelSurfaces = useRightPanelStore(
    (state) => selectThreadRightPanelState(state.byThreadKey, threadRef).surfaces,
  );
  const panelTerminalIds = new Set(
    panelSurfaces.flatMap((surface) => (surface.kind === "terminal" ? surface.terminalIds : [])),
  );
  const drawerTerminalSessions =
    knownTerminalSessions?.filter((session) => !panelTerminalIds.has(session.target.terminalId)) ??
    [];
  const terminalLabelsById = new Map<string, string>();
  for (const session of drawerTerminalSessions) {
    terminalLabelsById.set(
      session.target.terminalId,
      resolveTerminalSessionLabel(session.target.terminalId, session.state.summary),
    );
  }
  const terminalStatusById = new Map<string, TerminalActivityStatus>();
  for (const session of drawerTerminalSessions) {
    terminalStatusById.set(session.target.terminalId, resolveTerminalActivityStatus(session.state));
  }
  const terminalLaunchLocationsById = new Map<
    string,
    {
      readonly cwd: string;
      readonly worktreePath: string | null;
      readonly runtimeEnv: Record<string, string>;
    }
  >();
  if (root !== null) {
    for (const session of drawerTerminalSessions) {
      const summary = session.state.summary;
      if (!summary) {
        continue;
      }
      const worktreePathForLaunch =
        launchContext !== null ? launchContext.worktreePath : summary.worktreePath;
      terminalLaunchLocationsById.set(session.target.terminalId, {
        cwd: launchContext?.cwd ?? summary.cwd,
        worktreePath: worktreePathForLaunch,
        runtimeEnv: shellRuntimeEnv(project, worktreePathForLaunch),
      });
    }
  }
  const serverOrderedTerminalIds = drawerTerminalSessions.map(
    (session) => session.target.terminalId,
  );
  // Every client-side id source participates in allocation: the server list
  // lags fresh opens, and panel terminals are filtered out of the drawer's
  // sessions — an id collision attaches two viewports to one PTY session.
  const allocatableTerminalIds = [
    ...new Set([...serverOrderedTerminalIds, ...terminalUiState.terminalIds, ...panelTerminalIds]),
  ];
  const allocateTerminalId = () =>
    nextTerminalId(
      allocatableTerminalIds,
      knownTerminalSessions === null ||
        !readEnvironmentScope(threadRef.environmentId, AuthTerminalReadScope)
        ? randomUUID()
        : undefined,
    );
  const storeSetTerminalHeight = useTerminalUiStateStore((state) => state.setTerminalHeight);
  const storeSplitTerminal = useTerminalUiStateStore((state) => state.splitTerminal);
  const storeSplitTerminalVertical = useTerminalUiStateStore(
    (state) => state.splitTerminalVertical,
  );
  const storeNewTerminal = useTerminalUiStateStore((state) => state.newTerminal);
  const storeSetActiveTerminal = useTerminalUiStateStore((state) => state.setActiveTerminal);
  const storeCloseTerminal = useTerminalUiStateStore((state) => state.closeTerminal);
  const reconcileTerminalIds = useTerminalUiStateStore((state) => state.reconcileTerminalIds);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Reconcile terminal UI ids with asynchronously discovered server sessions while preserving pending client terminals.
  useEffect(() => {
    if (terminalIdListsEqual(serverOrderedTerminalIds, terminalUiState.terminalIds)) {
      return;
    }
    if (
      serverTerminalIdsStrictSubsetOfClient(serverOrderedTerminalIds, terminalUiState.terminalIds)
    ) {
      return;
    }
    reconcileTerminalIds(threadRef, serverOrderedTerminalIds);
  }, [reconcileTerminalIds, serverOrderedTerminalIds, terminalUiState.terminalIds, threadRef]);
  const worktreePath = serverThread?.worktreePath ?? draftThread?.worktreePath ?? null;
  const effectiveWorktreePath = launchContext !== null ? launchContext.worktreePath : worktreePath;
  const cwd =
    launchContext?.cwd ??
    (root !== null
      ? projectScriptCwd({ project: { cwd: root }, worktreePath: effectiveWorktreePath })
      : null);
  const runtimeEnv = shellRuntimeEnv(project, effectiveWorktreePath);

  const requestTerminalFocus = (terminalId?: string) => {
    if (!visible) return;
    if (terminalId) focusTerminal(threadRef, terminalId);
    else focusActiveDrawerTerminal(threadRef);
  };

  const setTerminalHeight = (height: number) => {
    storeSetTerminalHeight(threadRef, height);
  };

  const splitLimitReached =
    (terminalUiState.terminalGroups.find(
      (group) => group.id === terminalUiState.activeTerminalGroupId,
    )?.terminalIds.length ?? 0) >= MAX_TERMINALS_PER_GROUP;
  const splitTerminal = () => {
    if (!hasTerminalWriteAccess() || !cwd || splitLimitReached) {
      return;
    }
    const terminalId = allocateTerminalId();
    storeSplitTerminal(threadRef, terminalId);
    requestTerminalFocus(terminalId);
    void openTerminal({
      environmentId: threadRef.environmentId,
      input: {
        threadId,
        terminalId,
        cwd,
        ...(effectiveWorktreePath != null ? { worktreePath: effectiveWorktreePath } : {}),
        env: runtimeEnv,
      },
    });
  };
  const splitTerminalVertical = () => {
    if (!hasTerminalWriteAccess() || !cwd || splitLimitReached) {
      return;
    }
    const terminalId = allocateTerminalId();
    storeSplitTerminalVertical(threadRef, terminalId);
    requestTerminalFocus(terminalId);
    void openTerminal({
      environmentId: threadRef.environmentId,
      input: {
        threadId,
        terminalId,
        cwd,
        ...(effectiveWorktreePath != null ? { worktreePath: effectiveWorktreePath } : {}),
        env: runtimeEnv,
      },
    });
  };

  const createNewTerminal = () => {
    if (!hasTerminalWriteAccess() || !cwd) {
      return;
    }
    const terminalId = allocateTerminalId();
    storeNewTerminal(threadRef, terminalId);
    requestTerminalFocus(terminalId);
    void openTerminal({
      environmentId: threadRef.environmentId,
      input: {
        threadId,
        terminalId,
        cwd,
        ...(effectiveWorktreePath != null ? { worktreePath: effectiveWorktreePath } : {}),
        env: runtimeEnv,
      },
    });
  };

  const activateTerminal = (terminalId: string) => {
    storeSetActiveTerminal(threadRef, terminalId);
    requestTerminalFocus(terminalId);
  };

  const closeTerminal = (terminalId: string) => {
    if (!hasTerminalWriteAccess()) return;
    const fallbackExitWrite = () =>
      writeTerminal({
        environmentId: threadRef.environmentId,
        input: { threadId, terminalId, data: "exit\n" },
      });

    void (async () => {
      const closeResult = await closeTerminalMutation({
        environmentId: threadRef.environmentId,
        input: {
          threadId,
          terminalId,
          deleteHistory: true,
        },
      });
      if (
        closeResult._tag === "Failure" &&
        !isAtomCommandInterrupted(closeResult) &&
        hasTerminalWriteAccess()
      ) {
        await fallbackExitWrite();
      }
    })();

    storeCloseTerminal(threadRef, terminalId);
    requestTerminalFocus();
  };

  const handleAddTerminalContext = (selection: TerminalContextSelection) => {
    if (!visible || !onAddTerminalContext) return Promise.resolve(false);
    return onAddTerminalContext(selection);
  };

  if (root === null || (!terminalUiState.terminalOpen && !active) || !cwd) {
    return null;
  }

  const drawer = (
    <ThreadTerminalDrawer
      mode={paneMode ? "pane" : "drawer"}
      threadRef={threadRef}
      threadId={threadId}
      cwd={cwd}
      worktreePath={effectiveWorktreePath}
      runtimeEnv={runtimeEnv}
      visible={visible}
      height={terminalUiState.terminalHeight}
      terminalIds={canOperateTerminal ? terminalUiState.terminalIds : serverOrderedTerminalIds}
      activeTerminalId={terminalUiState.activeTerminalId}
      terminalGroups={terminalUiState.terminalGroups}
      activeTerminalGroupId={terminalUiState.activeTerminalGroupId}
      onSplitTerminal={splitTerminal}
      onSplitTerminalVertical={splitTerminalVertical}
      onNewTerminal={createNewTerminal}
      splitShortcutLabel={visible ? splitShortcutLabel : undefined}
      splitVerticalShortcutLabel={visible ? splitVerticalShortcutLabel : undefined}
      newShortcutLabel={visible ? newShortcutLabel : undefined}
      closeShortcutLabel={visible ? closeShortcutLabel : undefined}
      keybindings={keybindings}
      onActiveTerminalChange={activateTerminal}
      onCloseTerminal={closeTerminal}
      onHeightChange={setTerminalHeight}
      onAddTerminalContext={onAddTerminalContext ? handleAddTerminalContext : undefined}
      terminalLabelsById={terminalLabelsById}
      terminalStatusById={terminalStatusById}
      terminalLaunchLocationsById={terminalLaunchLocationsById}
      attaching={attaching}
    />
  );
  if (paneMode) return drawer;

  return (
    <div
      className={cn(
        "grid shrink-0 overflow-clip",
        active ? (visible ? "grid-rows-[1fr]" : "grid-rows-[0fr]") : "hidden",
        active &&
          "[[data-panel-animations=true]_&]:transition-[grid-template-rows] [[data-panel-animations=true]_&]:duration-(--panel-animation-duration) [[data-panel-animations=true]_&]:ease-out",
        active && visible && "[[data-panel-animations=true]_&]:starting:grid-rows-[0fr]!",
      )}
    >
      <div className="min-h-0 overflow-clip">{drawer}</div>
    </div>
  );
});

interface PersistentThreadTerminalPanelProps {
  visible: boolean;
  threadRef: ScopedThreadRef;
  surface: Extract<RightPanelSurface, { kind: "terminal" }>;
  launchContext: PersistentTerminalLaunchContext | null;
  keybindings: ResolvedKeybindingsConfig;
  onAddTerminalContext:
    | ((selection: TerminalContextSelection) => void | Promise<boolean>)
    | undefined;
  onSplitTerminal: () => void;
  onSplitTerminalVertical: () => void;
  onNewTerminal: () => void;
  onActiveTerminalChange: (terminalId: string) => void;
  onCloseTerminal: (terminalId: string, threadRef?: ScopedThreadRef) => void;
  splitShortcutLabel?: string | undefined;
  splitVerticalShortcutLabel?: string | undefined;
  newShortcutLabel?: string | undefined;
  closeShortcutLabel?: string | undefined;
}

export const PersistentThreadTerminalPanel = memo(function PersistentThreadTerminalPanel({
  visible,
  threadRef,
  surface,
  launchContext,
  keybindings,
  onAddTerminalContext,
  onSplitTerminal,
  onSplitTerminalVertical,
  onNewTerminal,
  onActiveTerminalChange,
  onCloseTerminal,
  splitShortcutLabel,
  splitVerticalShortcutLabel,
  newShortcutLabel,
  closeShortcutLabel,
}: PersistentThreadTerminalPanelProps) {
  const serverThread = useQuietThreadShell(threadRef);
  const draftThread = useComposerDraftStore((store) => store.getDraftThreadByRef(threadRef));
  const projectRef = serverThread
    ? scopeProjectRef(serverThread.environmentId, serverThread.projectId)
    : draftThread
      ? scopeProjectRef(draftThread.environmentId, draftThread.projectId)
      : threadlessSurfacesProjectRef(threadRef);
  const project = useProject(projectRef);
  // Shells open in its project's root, or a project-less threadless ref's server home.
  const home = useThreadlessHome(threadRef);
  const root = project?.workspaceRoot ?? home;
  const knownTerminalSessions = useKnownTerminalSessions({
    environmentId: threadRef.environmentId,
    threadId: threadRef.threadId,
  });
  const threadWorktreePath = serverThread?.worktreePath ?? draftThread?.worktreePath ?? null;
  const activeSummary =
    knownTerminalSessions?.find((session) => session.target.terminalId === surface.activeTerminalId)
      ?.state.summary ?? null;
  const worktreePath = resolveTerminalWorktreePath({
    launchContext,
    summary: activeSummary,
    threadWorktreePath,
  });
  const cwd =
    launchContext?.cwd ??
    activeSummary?.cwd ??
    (root !== null ? projectScriptCwd({ project: { cwd: root }, worktreePath }) : null);
  const runtimeEnv = shellRuntimeEnv(project, worktreePath);
  const terminalLabelsById = new Map<string, string>();
  for (const terminalId of surface.terminalIds) {
    const summary =
      knownTerminalSessions?.find((session) => session.target.terminalId === terminalId)?.state
        .summary ?? null;
    terminalLabelsById.set(terminalId, resolveTerminalSessionLabel(terminalId, summary));
  }
  const terminalLaunchLocationsById = new Map<
    string,
    {
      readonly cwd: string;
      readonly worktreePath: string | null;
      readonly runtimeEnv: Record<string, string>;
    }
  >();
  for (const terminalId of surface.terminalIds) {
    const summary =
      knownTerminalSessions?.find((session) => session.target.terminalId === terminalId)?.state
        .summary ?? null;
    const terminalWorktreePath = resolveTerminalWorktreePath({
      launchContext,
      summary,
      threadWorktreePath,
    });
    const terminalCwd =
      launchContext?.cwd ??
      summary?.cwd ??
      (root !== null
        ? projectScriptCwd({ project: { cwd: root }, worktreePath: terminalWorktreePath })
        : null);
    if (!terminalCwd || root === null) continue;
    terminalLaunchLocationsById.set(terminalId, {
      cwd: terminalCwd,
      worktreePath: terminalWorktreePath,
      runtimeEnv: shellRuntimeEnv(project, terminalWorktreePath),
    });
  }

  if (root === null || !cwd) return null;

  return (
    <ThreadTerminalDrawer
      mode="panel"
      visible={visible}
      threadRef={threadRef}
      threadId={threadRef.threadId}
      cwd={cwd}
      worktreePath={worktreePath}
      runtimeEnv={runtimeEnv}
      height={0}
      terminalIds={surface.terminalIds}
      activeTerminalId={surface.activeTerminalId}
      terminalGroups={[
        {
          id: surface.id,
          terminalIds: surface.terminalIds,
          ...(surface.splitDirection === "vertical" ? { splitDirection: "vertical" as const } : {}),
        },
      ]}
      activeTerminalGroupId={surface.id}
      onSplitTerminal={onSplitTerminal}
      onSplitTerminalVertical={onSplitTerminalVertical}
      onNewTerminal={onNewTerminal}
      splitShortcutLabel={splitShortcutLabel}
      splitVerticalShortcutLabel={splitVerticalShortcutLabel}
      newShortcutLabel={newShortcutLabel}
      closeShortcutLabel={closeShortcutLabel}
      onActiveTerminalChange={onActiveTerminalChange}
      onCloseTerminal={onCloseTerminal}
      onHeightChange={() => undefined}
      onAddTerminalContext={onAddTerminalContext}
      terminalLabelsById={terminalLabelsById}
      terminalLaunchLocationsById={terminalLaunchLocationsById}
      keybindings={keybindings}
    />
  );
});
