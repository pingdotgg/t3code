import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as ThreadTerminalLauncher from "../../../terminal/ThreadTerminalLauncher.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { assertFullAccess, readThread, unavailable } from "../../threadAccess.ts";
import { TerminalToolkit } from "./tools.ts";

const terminalFailure = (error: ThreadTerminalLauncher.ThreadTerminalLaunchError) =>
  error._tag === "ThreadTerminalProjectNotFoundError" ||
  error._tag === "ThreadTerminalCwdOutsideWorkspaceError" ||
  error._tag === "TerminalCwdNotFoundError" ||
  error._tag === "TerminalCwdNotDirectoryError"
    ? new OrchestratorMcpFailure({ code: "invalid_request", message: error.message })
    : unavailable();

const handlers = {
  // The target must be within the caller's modes, like any write to another
  // thread, and the caller must be full-access: a typed command runs outside
  // the provider's sandbox and approval flow.
  t3_terminal_open: McpToolAccess.writesThreads(
    (input) => [input.threadId],
    (input) =>
      Effect.gen(function* () {
        const context = yield* readThread(input.threadId);
        yield* assertFullAccess(
          context,
          "Opening a terminal needs a live full-access/default calling thread or a full-access client.",
        );
        const { thread } = context.projection;
        const launcher = yield* ThreadTerminalLauncher.ThreadTerminalLauncher;
        const session = yield* launcher
          .open({
            thread: {
              id: thread.id,
              projectId: thread.projectId,
              worktreePath: thread.worktreePath,
            },
            ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
            ...(input.env !== undefined ? { env: input.env } : {}),
            ...(input.command !== undefined ? { command: input.command } : {}),
            ...(input.terminalId !== undefined ? { terminalId: input.terminalId } : {}),
          })
          .pipe(Effect.mapError(terminalFailure));
        return {
          threadId: thread.id,
          terminalId: session.terminalId,
          cwd: session.cwd,
          pid: session.pid,
          status: session.status,
        };
      }),
  ),
} satisfies McpToolAccess.Handlers<typeof TerminalToolkit.tools>;

export const layer = McpToolAccess.toLayer(TerminalToolkit, handlers);
