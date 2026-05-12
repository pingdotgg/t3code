import { scopeProjectRef, scopedThreadKey } from "@forma/client-runtime";
import type { ScopedThreadRef, ThreadId } from "@forma/contracts";
import { memo, useCallback, useMemo, useState } from "react";

import { projectScriptCwd, projectScriptRuntimeEnv } from "@forma/shared/projectScripts";
import { randomUUID } from "~/lib/utils";
import { readEnvironmentApi } from "../environmentApi";
import { useComposerHandleContext } from "../composerHandleContext";
import { useComposerDraftStore } from "../composerDraftStore";
import { shortcutLabelForCommand } from "../keybindings";
import { useServerKeybindings } from "../rpc/serverState";
import { createProjectSelectorByRef, createThreadSelectorByRef } from "../storeSelectors";
import { useStore } from "../store";
import { selectThreadTerminalState, useTerminalStateStore } from "../terminalStateStore";
import { type TerminalContextSelection } from "../lib/terminalContext";
import ThreadTerminalDrawer from "./ThreadTerminalDrawer";

interface PersistentThreadTerminalPanelProps {
  threadRef: ScopedThreadRef;
  threadId: ThreadId;
  onClosePanel: () => void;
}

export const PersistentThreadTerminalPanel = memo(function PersistentThreadTerminalPanel({
  threadRef,
  threadId,
  onClosePanel,
}: PersistentThreadTerminalPanelProps) {
  const composerHandleRef = useComposerHandleContext();
  const serverThread = useStore(useMemo(() => createThreadSelectorByRef(threadRef), [threadRef]));
  const draftThread = useComposerDraftStore((store) => store.getDraftThreadByRef(threadRef));
  const projectRef = serverThread
    ? scopeProjectRef(serverThread.environmentId, serverThread.projectId)
    : draftThread
      ? scopeProjectRef(draftThread.environmentId, draftThread.projectId)
      : null;
  const project = useStore(useMemo(() => createProjectSelectorByRef(projectRef), [projectRef]));
  const terminalState = useTerminalStateStore((state) =>
    selectThreadTerminalState(state.terminalStateByThreadKey, threadRef),
  );
  const keybindings = useServerKeybindings();
  const launchContext = useTerminalStateStore(
    (state) => state.terminalLaunchContextByThreadKey[scopedThreadKey(threadRef)] ?? null,
  );
  const storeSplitTerminal = useTerminalStateStore((state) => state.splitTerminal);
  const storeNewTerminal = useTerminalStateStore((state) => state.newTerminal);
  const storeSetActiveTerminal = useTerminalStateStore((state) => state.setActiveTerminal);
  const storeCloseTerminal = useTerminalStateStore((state) => state.closeTerminal);
  const [focusRequestId, setFocusRequestId] = useState(0);
  const worktreePath = serverThread?.worktreePath ?? draftThread?.worktreePath ?? null;
  const effectiveWorktreePath = useMemo(
    () => launchContext?.worktreePath ?? worktreePath,
    [launchContext?.worktreePath, worktreePath],
  );
  const cwd = useMemo(
    () =>
      launchContext?.cwd ??
      (project
        ? projectScriptCwd({
            project: { cwd: project.cwd },
            worktreePath: effectiveWorktreePath,
          })
        : null),
    [effectiveWorktreePath, launchContext?.cwd, project],
  );
  const runtimeEnv = useMemo(
    () =>
      project
        ? projectScriptRuntimeEnv({
            project: { cwd: project.cwd },
            worktreePath: effectiveWorktreePath,
          })
        : {},
    [effectiveWorktreePath, project],
  );

  const bumpFocusRequestId = useCallback(() => {
    setFocusRequestId((value) => value + 1);
  }, []);

  const splitTerminal = useCallback(() => {
    storeSplitTerminal(threadRef, `terminal-${randomUUID()}`);
    bumpFocusRequestId();
  }, [bumpFocusRequestId, storeSplitTerminal, threadRef]);

  const createNewTerminal = useCallback(() => {
    storeNewTerminal(threadRef, `terminal-${randomUUID()}`);
    bumpFocusRequestId();
  }, [bumpFocusRequestId, storeNewTerminal, threadRef]);

  const activateTerminal = useCallback(
    (terminalId: string) => {
      storeSetActiveTerminal(threadRef, terminalId);
      bumpFocusRequestId();
    },
    [bumpFocusRequestId, storeSetActiveTerminal, threadRef],
  );

  const closeTerminal = useCallback(
    (terminalId: string) => {
      const api = readEnvironmentApi(threadRef.environmentId);
      if (!api) return;
      const isFinalTerminal = terminalState.terminalIds.length <= 1;
      const fallbackExitWrite = () =>
        api.terminal.write({ threadId, terminalId, data: "exit\n" }).catch(() => undefined);

      if ("close" in api.terminal && typeof api.terminal.close === "function") {
        void (async () => {
          if (isFinalTerminal) {
            await api.terminal.clear({ threadId, terminalId }).catch(() => undefined);
          }
          await api.terminal.close({
            threadId,
            terminalId,
            deleteHistory: true,
          });
        })().catch(() => fallbackExitWrite());
      } else {
        void fallbackExitWrite();
      }

      storeCloseTerminal(threadRef, terminalId);
      if (isFinalTerminal) {
        onClosePanel();
        return;
      }
      bumpFocusRequestId();
    },
    [
      bumpFocusRequestId,
      onClosePanel,
      storeCloseTerminal,
      terminalState.terminalIds.length,
      threadId,
      threadRef,
    ],
  );

  const handleAddTerminalContext = useCallback(
    (selection: TerminalContextSelection) => {
      composerHandleRef?.current?.addTerminalContext(selection);
    },
    [composerHandleRef],
  );

  if (!project || !terminalState.terminalOpen || !cwd) {
    return null;
  }

  return (
    <ThreadTerminalDrawer
      layout="panel"
      threadRef={threadRef}
      threadId={threadId}
      cwd={cwd}
      worktreePath={effectiveWorktreePath}
      runtimeEnv={runtimeEnv}
      visible
      terminalIds={terminalState.terminalIds}
      activeTerminalId={terminalState.activeTerminalId}
      terminalGroups={terminalState.terminalGroups}
      activeTerminalGroupId={terminalState.activeTerminalGroupId}
      focusRequestId={focusRequestId + 1}
      onSplitTerminal={splitTerminal}
      onNewTerminal={createNewTerminal}
      splitShortcutLabel={
        shortcutLabelForCommand(keybindings, "terminal.split", {
          context: { terminalFocus: true, terminalOpen: true },
        }) ?? undefined
      }
      newShortcutLabel={
        shortcutLabelForCommand(keybindings, "terminal.new", {
          context: { terminalFocus: true, terminalOpen: true },
        }) ?? undefined
      }
      closeShortcutLabel={
        shortcutLabelForCommand(keybindings, "terminal.close", {
          context: { terminalFocus: true, terminalOpen: true },
        }) ?? undefined
      }
      onActiveTerminalChange={activateTerminal}
      onCloseTerminal={closeTerminal}
      onAddTerminalContext={handleAddTerminalContext}
      keybindings={keybindings}
    />
  );
});
