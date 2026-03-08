import { type ThreadId } from "@t3tools/contracts";
import { useCallback, useRef, useState } from "react";

import { MAX_THREAD_TERMINAL_COUNT } from "../types";
import { readNativeApi } from "../nativeApi";
import { selectThreadTerminalState, useTerminalStateStore } from "../terminalStateStore";
import ThreadTerminalDrawer from "./ThreadTerminalDrawer";

interface ScopedTerminalDrawerProps {
  threadId: ThreadId;
  cwd: string;
  label?: string;
  splitShortcutLabel?: string;
  newShortcutLabel?: string;
  closeShortcutLabel?: string;
}

/**
 * ScopedTerminalDrawer — a self-contained terminal drawer that manages its
 * own state via `terminalStateStore` for a given (potentially synthetic)
 * `threadId`. Renders nothing if the terminal has never been opened; once
 * opened, stays mounted with `visible=false` when closed.
 *
 * Used for per-project terminals (keyed by `project:<projectId>`) and the
 * global terminal (keyed by `"global"`).
 */
export default function ScopedTerminalDrawer({
  threadId,
  cwd,
  label,
  splitShortcutLabel,
  newShortcutLabel,
  closeShortcutLabel,
}: ScopedTerminalDrawerProps) {
  const terminalState = useTerminalStateStore((state) =>
    selectThreadTerminalState(state.terminalStateByThreadId, threadId),
  );
  const storeSetTerminalHeight = useTerminalStateStore((s) => s.setTerminalHeight);
  const storeSplitTerminal = useTerminalStateStore((s) => s.splitTerminal);
  const storeNewTerminal = useTerminalStateStore((s) => s.newTerminal);
  const storeSetActiveTerminal = useTerminalStateStore((s) => s.setActiveTerminal);
  const storeCloseTerminal = useTerminalStateStore((s) => s.closeTerminal);
  const [focusRequestId, setFocusRequestId] = useState(0);
  const hasEverOpenedRef = useRef(terminalState.terminalOpen);
  if (terminalState.terminalOpen) {
    hasEverOpenedRef.current = true;
  }

  const hasReachedTerminalLimit = terminalState.terminalIds.length >= MAX_THREAD_TERMINAL_COUNT;

  const setTerminalHeight = useCallback(
    (height: number) => {
      storeSetTerminalHeight(threadId, height);
    },
    [threadId, storeSetTerminalHeight],
  );

  const splitTerminal = useCallback(() => {
    if (hasReachedTerminalLimit) return;
    const terminalId = `terminal-${crypto.randomUUID()}`;
    storeSplitTerminal(threadId, terminalId);
    setFocusRequestId((v) => v + 1);
  }, [threadId, storeSplitTerminal, hasReachedTerminalLimit]);

  const createNewTerminal = useCallback(() => {
    if (hasReachedTerminalLimit) return;
    const terminalId = `terminal-${crypto.randomUUID()}`;
    storeNewTerminal(threadId, terminalId);
    setFocusRequestId((v) => v + 1);
  }, [threadId, storeNewTerminal, hasReachedTerminalLimit]);

  const activateTerminal = useCallback(
    (terminalId: string) => {
      storeSetActiveTerminal(threadId, terminalId);
      setFocusRequestId((v) => v + 1);
    },
    [threadId, storeSetActiveTerminal],
  );

  const closeTerminal = useCallback(
    (terminalId: string) => {
      const api = readNativeApi();
      if (!api) return;
      const isFinalTerminal = terminalState.terminalIds.length <= 1;
      const fallbackExitWrite = () =>
        api.terminal.write({ threadId, terminalId, data: "exit\n" }).catch(() => undefined);
      if ("close" in api.terminal && typeof api.terminal.close === "function") {
        void (async () => {
          if (isFinalTerminal) {
            await api.terminal.clear({ threadId, terminalId }).catch(() => undefined);
          }
          await api.terminal.close({ threadId, terminalId, deleteHistory: true });
        })().catch(() => fallbackExitWrite());
      } else {
        void fallbackExitWrite();
      }
      storeCloseTerminal(threadId, terminalId);
      setFocusRequestId((v) => v + 1);
    },
    [threadId, storeCloseTerminal, terminalState.terminalIds.length],
  );

  if (!hasEverOpenedRef.current) {
    return null;
  }

  return (
    <ThreadTerminalDrawer
      threadId={threadId}
      cwd={cwd}
      label={label}
      visible={terminalState.terminalOpen}
      height={terminalState.terminalHeight}
      terminalIds={terminalState.terminalIds}
      activeTerminalId={terminalState.activeTerminalId}
      terminalGroups={terminalState.terminalGroups}
      activeTerminalGroupId={terminalState.activeTerminalGroupId}
      focusRequestId={focusRequestId}
      onSplitTerminal={splitTerminal}
      onNewTerminal={createNewTerminal}
      splitShortcutLabel={splitShortcutLabel}
      newShortcutLabel={newShortcutLabel}
      closeShortcutLabel={closeShortcutLabel}
      onActiveTerminalChange={activateTerminal}
      onCloseTerminal={closeTerminal}
      onHeightChange={setTerminalHeight}
    />
  );
}
