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

/** Replay the measured grid when a writable attachment becomes ready or reconnects. */
export function useTerminalGridSync({
  environmentId,
  threadId,
  terminalId,
  canOperate,
  terminal,
  size,
  resize,
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
}): void {
  const generation =
    canOperate && terminal.version > 0 && terminal.status === "running"
      ? terminal.output.generation
      : null;

  useEffect(() => {
    if (
      generation === null ||
      environmentId === null ||
      threadId === null ||
      !readEnvironmentScope(environmentId, AuthTerminalOperateScope)
    )
      return;
    resize({
      environmentId,
      input: { threadId, terminalId, cols: size.cols, rows: size.rows },
    });
  }, [environmentId, generation, resize, size.cols, size.rows, terminalId, threadId]);
}
