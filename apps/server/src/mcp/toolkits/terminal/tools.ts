import {
  OrchestratorMcpFailure,
  TerminalSessionStatus,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as TerminalManager from "../../../terminal/Manager.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const MAX_OUTPUT_CHARACTERS = 50_000;
// The terminal write limit, less one character for the optional Enter.
const MAX_INPUT_CHARACTERS = 65_535;

const TerminalId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ProjectService.ProjectService,
    TerminalManager.TerminalManager,
  ],
};

const TerminalListTool = Tool.make("t3_terminal_list", {
  ...shared,
  description:
    "List a thread's terminals (omit threadId for this thread): the shells users see in the app's terminal panel. Only terminals loaded since the server started are listed. hasRunningSubprocess is true while a command runs in the shell.",
  parameters: Schema.Struct({ threadId: Schema.optional(ThreadId) }),
  success: Schema.Struct({
    threadId: ThreadId,
    terminals: Schema.Array(
      Schema.Struct({
        terminalId: Schema.String,
        label: Schema.String,
        status: TerminalSessionStatus,
        hasRunningSubprocess: Schema.Boolean,
        exitCode: Schema.NullOr(Schema.Int),
        cwd: Schema.String,
        updatedAt: Schema.String,
      }),
    ),
  }),
})
  .annotate(Tool.Title, "List thread terminals")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const TerminalReadTool = Tool.make("t3_terminal_read", {
  ...shared,
  description: `Read recent output of a thread terminal (omit threadId for this thread) from its retained scrollback. Escape sequences are stripped and carriage-return redraws keep their last write. Returns the last maxCharacters (default 10,000, max ${MAX_OUTPUT_CHARACTERS.toLocaleString("en-US")}) with truncated set when older output was cut. Does not start a terminal. Requires a full-access/default caller, since scrollback can hold secrets.`,
  parameters: Schema.Struct({
    threadId: Schema.optional(ThreadId),
    terminalId: TerminalId,
    maxCharacters: Schema.optional(
      Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_OUTPUT_CHARACTERS })),
    ),
  }),
  success: Schema.Struct({
    threadId: ThreadId,
    terminalId: Schema.String,
    label: Schema.String,
    status: TerminalSessionStatus,
    exitCode: Schema.NullOr(Schema.Int),
    cwd: Schema.String,
    output: Schema.String,
    truncated: Schema.Boolean,
  }),
})
  .annotate(Tool.Title, "Read terminal output")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const TerminalControlTool = Tool.make("t3_terminal_control", {
  ...shared,
  description:
    "Open, type into, or close a thread terminal (omit threadId for this thread); it appears in the app's terminal panel. open starts a shell in the thread's checkout, or returns the terminal as is when it already runs; omit terminalId to open a new one. write sends text to a running terminal; pass enter to press Enter after it, and control characters such as \\u0003 (Ctrl-C) are sent as typed. Success means the shell received the input, not that a command succeeded; follow with t3_terminal_read. close stops the shell and discards its scrollback. Runs arbitrary commands, so it requires a full-access/default caller.",
  parameters: Schema.Struct({
    threadId: Schema.optional(ThreadId),
    action: Schema.Literals(["open", "write", "close"]),
    terminalId: Schema.optional(TerminalId),
    text: Schema.optional(Schema.String.check(Schema.isMaxLength(MAX_INPUT_CHARACTERS))),
    enter: Schema.optional(Schema.Boolean),
  }),
  success: Schema.Struct({
    threadId: ThreadId,
    terminalId: Schema.String,
    status: Schema.Literals([...TerminalSessionStatus.literals, "closed"]),
    // open only: whether the shell was already running before this call.
    alreadyRunning: Schema.optional(Schema.Boolean),
  }),
})
  .annotate(Tool.Title, "Control a thread terminal")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

export const TerminalToolkit = Toolkit.make(
  TerminalListTool,
  TerminalReadTool,
  TerminalControlTool,
);
