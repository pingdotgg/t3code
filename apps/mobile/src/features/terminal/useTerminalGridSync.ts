import type { TerminalSessionState } from "@t3tools/client-runtime/state/terminal";
import {
  AuthTerminalOperateScope,
  type EnvironmentId,
  type TerminalResizeInput,
  type ThreadId,
} from "@t3tools/contracts";
import { useEffect } from "react";

import type { TerminalGridSize } from "./terminalUiState";
import { readEnvironmentScope } from "../../state/session";

export function useTerminalGridSync({
  environmentId,
  threadId,
  terminalId,
  canOperate,
  terminal,
  size,
  resize,
  settleDelayMs = 0,
}: {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId | null;
  readonly terminalId: string;
  readonly canOperate: boolean;
  readonly terminal: Pick<TerminalSessionState, "output" | "status" | "version">;
  readonly size: TerminalGridSize;
  readonly resize: (target: {
    readonly environmentId: EnvironmentId;
    readonly input: TerminalResizeInput;
  }) => void;
  readonly settleDelayMs?: number;
}): void {
  const generation =
    canOperate && terminal.version > 0 && terminal.status === "running"
      ? terminal.output.generation
      : null;

  useEffect(() => {
    if (generation === null || environmentId === null || threadId === null) return;
    const dispatch = () => {
      if (!readEnvironmentScope(environmentId, AuthTerminalOperateScope)) return;
      resize({
        environmentId,
        input: { threadId, terminalId, cols: size.cols, rows: size.rows },
      });
    };
    // Animate the local viewport freely, but reflow the shared PTY only after
    // its measured grid has stopped changing. Cancel stale targets on cleanup.
    if (settleDelayMs === 0) {
      dispatch();
      return;
    }
    const timeout = setTimeout(dispatch, settleDelayMs);
    return () => clearTimeout(timeout);
  }, [
    environmentId,
    generation,
    resize,
    settleDelayMs,
    size.cols,
    size.rows,
    terminalId,
    threadId,
  ]);
}
