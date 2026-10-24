import {
  OrchestratorMcpFailure,
  TerminalOpenInput,
  TerminalSessionStatus,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ThreadTerminalLauncher from "../../../terminal/ThreadTerminalLauncher.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const TerminalOpenTool = Tool.make("t3_terminal_open", {
  description:
    "Open a terminal tab in a thread's terminal drawer (omit threadId for this thread), optionally typing a command into it. Use it for interactive programs that need a real TTY or the user's input, such as a CLI login flow; the user sees and can type into the terminal. cwd defaults to the thread's workspace and must stay inside the project root or the thread's worktree; relative paths resolve against the thread's workspace. env is added on top of the server environment. Omit terminalId to open a new terminal; reusing the id of a running terminal with a different cwd or env restarts it. Needs a full-access caller.",
  parameters: Schema.Struct({
    threadId: Schema.optional(ThreadId),
    cwd: Schema.optional(TrimmedNonEmptyString),
    env: TerminalOpenInput.fields.env,
    command: Schema.optional(TrimmedNonEmptyString),
    terminalId: Schema.optional(TerminalOpenInput.fields.terminalId),
  }),
  success: Schema.Struct({
    threadId: ThreadId,
    terminalId: Schema.String,
    cwd: Schema.String,
    pid: Schema.NullOr(Schema.Int),
    status: TerminalSessionStatus,
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ThreadTerminalLauncher.ThreadTerminalLauncher,
  ],
})
  .annotate(Tool.Title, "Open a thread terminal")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

export const TerminalToolkit = Toolkit.make(TerminalOpenTool);
