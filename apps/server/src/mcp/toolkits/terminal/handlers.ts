import * as Effect from "effect/Effect";

import {
  DEFAULT_TERMINAL_ID,
  type TerminalOpenInput,
  type TerminalRunInput,
} from "@t3tools/contracts";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as TerminalManager from "../../../terminal/Manager.ts";
import { TerminalToolkit } from "./tools.ts";

const runTerminalCommand = Effect.fn("McpTerminal.runTerminalCommand")(function* (
  input: TerminalRunInput,
): Effect.fn.Return<
  import("@t3tools/contracts").TerminalSessionSnapshot,
  import("@t3tools/contracts").TerminalError,
  McpInvocationContext.McpInvocationContext | TerminalManager.TerminalManager
> {
  const invocation = yield* McpInvocationContext.McpInvocationContext;
  const terminalManager = yield* TerminalManager.TerminalManager;
  const terminalId = input.terminalId ?? DEFAULT_TERMINAL_ID;
  const openInput: TerminalOpenInput = {
    threadId: invocation.threadId,
    terminalId,
    cwd: input.cwd,
    ...(input.worktreePath !== undefined ? { worktreePath: input.worktreePath } : {}),
    ...(input.cols !== undefined ? { cols: input.cols } : {}),
    ...(input.rows !== undefined ? { rows: input.rows } : {}),
    ...(input.env !== undefined ? { env: input.env } : {}),
  };

  const snapshot = yield* terminalManager.open(openInput);
  yield* terminalManager.write({
    threadId: invocation.threadId,
    terminalId,
    data: `${input.command}\n`,
  });
  return snapshot;
});

const handlers = {
  terminal_run: (input) => runTerminalCommand(input),
} satisfies Parameters<typeof TerminalToolkit.toLayer>[0];

export const TerminalToolkitHandlersLive = TerminalToolkit.toLayer(handlers);
