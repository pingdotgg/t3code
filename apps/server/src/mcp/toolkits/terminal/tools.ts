import { TerminalError, TerminalSummary } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as TerminalManager from "../../../terminal/Manager.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [McpInvocationContext.McpInvocationContext, TerminalManager.TerminalManager];

/** Trailing output lines returned by `terminal_read` when the caller does not ask for a bound. */
export const TERMINAL_READ_DEFAULT_LINES = 200;

/**
 * Hard ceiling applied after the line bound, so a single pathological line
 * (minified bundle, base64 blob) can never blow up the agent's context.
 */
export const TERMINAL_READ_MAX_CHARACTERS = 32_000;

/** Total time `terminal_wait` blocks before reporting that the terminal is still busy. */
export const TERMINAL_WAIT_DEFAULT_TIMEOUT_MS = 30_000;

/**
 * How long a terminal must report no running subprocess before `terminal_wait`
 * calls it idle. The default sits above the manager's ~1s subprocess poll so a
 * command that has been submitted but not yet observed cannot read as idle.
 */
export const TERMINAL_WAIT_DEFAULT_QUIET_MS = 1_500;

/**
 * Plain `Schema.String` rather than the trimming codec from contracts: JSON
 * schema is generated from the encoded side, so a decoding transformation would
 * drop the field descriptions the model reads.
 */
const boundedText = (maxLength: number) =>
  Schema.String.check(Schema.isTrimmed())
    .check(Schema.isNonEmpty())
    .check(Schema.isMaxLength(maxLength));

const TerminalIdInput = boundedText(128).annotate({
  description:
    "Terminal to target, as returned by terminal_open or terminal_list, for example term-1.",
});

const TerminalColsInput = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(1),
  Schema.isLessThanOrEqualTo(1000),
).annotate({ description: "PTY width in columns. Defaults to 120." });

const TerminalRowsInput = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(1),
  Schema.isLessThanOrEqualTo(500),
).annotate({ description: "PTY height in rows. Defaults to 30." });

export const TerminalOpenToolInput = Schema.Struct({
  terminalId: Schema.optional(TerminalIdInput).annotate({
    description:
      "Reattach to this exact terminal, creating it when it does not exist. Omit to allocate the lowest free term-N id.",
  }),
  cwd: boundedText(4_096).annotate({
    description:
      "Absolute directory the shell starts in. Must already exist; create worktrees before opening a terminal inside them.",
  }),
  worktreePath: Schema.optional(Schema.NullOr(boundedText(4_096))).annotate({
    description:
      "Absolute path of the git worktree this terminal belongs to, when cwd lives inside one. Pass null for none.",
  }),
  cols: Schema.optional(TerminalColsInput).annotate({
    description: "PTY width in columns. Defaults to 120.",
  }),
  rows: Schema.optional(TerminalRowsInput).annotate({
    description: "PTY height in rows. Defaults to 30.",
  }),
});
export type TerminalOpenToolInput = typeof TerminalOpenToolInput.Type;

export const TerminalOpenToolResult = Schema.Struct({
  terminalId: Schema.String,
  terminal: TerminalSummary,
});
export type TerminalOpenToolResult = typeof TerminalOpenToolResult.Type;

export const TerminalWriteToolInput = Schema.Struct({
  terminalId: TerminalIdInput,
  data: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(65_535)).annotate({
    description:
      "Literal bytes to send to the PTY. Write the command without a trailing newline and let submit add it, or send control characters such as \\u0003 for Ctrl-C.",
  }),
  submit: Schema.optional(Schema.Boolean).annotate({
    description:
      "Append a carriage return so the shell runs the command. Defaults to true, and is skipped when data already ends in a newline. Set false to send raw keystrokes.",
  }),
});
export type TerminalWriteToolInput = typeof TerminalWriteToolInput.Type;

export const TerminalWriteToolResult = Schema.Struct({
  terminalId: Schema.String,
  submitted: Schema.Boolean,
});
export type TerminalWriteToolResult = typeof TerminalWriteToolResult.Type;

export const TerminalReadToolInput = Schema.Struct({
  terminalId: TerminalIdInput,
  lines: Schema.optional(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(5_000)),
  ).annotate({
    description: `Maximum number of trailing scrollback lines to return. Defaults to ${TERMINAL_READ_DEFAULT_LINES}; maximum 5000.`,
  }),
  stripAnsi: Schema.optional(Schema.Boolean).annotate({
    description:
      "Remove terminal escape sequences and collapse in-place line rewrites such as progress bars. Defaults to true.",
  }),
});
export type TerminalReadToolInput = typeof TerminalReadToolInput.Type;

export const TerminalReadToolResult = Schema.Struct({
  terminalId: Schema.String,
  status: Schema.String,
  hasRunningSubprocess: Schema.Boolean,
  output: Schema.String,
  lines: Schema.Int,
  truncated: Schema.Boolean,
});
export type TerminalReadToolResult = typeof TerminalReadToolResult.Type;

/**
 * `terminal_list` takes no parameters: the thread comes from the invocation
 * scope. Modeled as a record rather than an empty struct because an empty
 * struct encodes to `anyOf: [object, array]`, and tool input schemas have to be
 * plain objects.
 */
export const TerminalListToolInput = Schema.Record(Schema.String, Schema.Unknown);
export type TerminalListToolInput = typeof TerminalListToolInput.Type;

export const TerminalListToolResult = Schema.Struct({
  terminals: Schema.Array(TerminalSummary),
});
export type TerminalListToolResult = typeof TerminalListToolResult.Type;

export const TerminalWaitToolInput = Schema.Struct({
  terminalId: TerminalIdInput,
  timeoutMs: Schema.optional(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(100), Schema.isLessThanOrEqualTo(600_000)),
  ).annotate({
    description: `Give up after this many milliseconds and report timedOut. Defaults to ${TERMINAL_WAIT_DEFAULT_TIMEOUT_MS}; maximum 600000.`,
  }),
  quietMs: Schema.optional(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(250), Schema.isLessThanOrEqualTo(30_000)),
  ).annotate({
    description: `How long the terminal must report no running subprocess before it counts as idle. Defaults to ${TERMINAL_WAIT_DEFAULT_QUIET_MS}; keep it above 1000 so a just-submitted command is not mistaken for an idle shell.`,
  }),
});
export type TerminalWaitToolInput = typeof TerminalWaitToolInput.Type;

export const TerminalWaitToolResult = Schema.Struct({
  terminalId: Schema.String,
  idle: Schema.Boolean,
  timedOut: Schema.Boolean,
  terminal: Schema.NullOr(TerminalSummary),
});
export type TerminalWaitToolResult = typeof TerminalWaitToolResult.Type;

export const TerminalCloseToolInput = Schema.Struct({
  terminalId: TerminalIdInput,
  deleteHistory: Schema.optional(Schema.Boolean).annotate({
    description:
      "Also delete the persisted scrollback so the human cannot read it back. Defaults to false.",
  }),
});
export type TerminalCloseToolInput = typeof TerminalCloseToolInput.Type;

export const TerminalCloseToolResult = Schema.Struct({
  terminalId: Schema.String,
  closed: Schema.Boolean,
});
export type TerminalCloseToolResult = typeof TerminalCloseToolResult.Type;

const shellTool = <T extends Tool.Any>(tool: T): T =>
  tool.annotate(Tool.OpenWorld, true).annotate(Tool.Destructive, true) as T;

const readonlyShellTool = <T extends Tool.Any>(tool: T): T =>
  shellTool(tool)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Idempotent, true) as T;

export const TerminalOpenTool = shellTool(
  Tool.make("terminal_open", {
    description:
      "Open a persistent shell in this thread's terminal drawer, where the human can watch and take over. Reattaches when terminalId already exists, otherwise spawns a new PTY in cwd. Pass worktreePath when cwd is inside a git worktree you created.",
    parameters: TerminalOpenToolInput,
    success: TerminalOpenToolResult,
    failure: TerminalError,
    dependencies,
  })
    .annotate(Tool.Title, "Open terminal")
    .annotate(Tool.Destructive, false),
);

export const TerminalWriteTool = shellTool(
  Tool.make("terminal_write", {
    description:
      "Send input to a terminal. By default the input is submitted: a carriage return is appended unless data already ends in a newline, so pass the bare command such as 'pnpm test'. Set submit=false to send raw keystrokes without running them. Writing does not wait for the command; follow with terminal_wait and terminal_read.",
    parameters: TerminalWriteToolInput,
    success: TerminalWriteToolResult,
    failure: TerminalError,
    dependencies,
  }).annotate(Tool.Title, "Write to terminal"),
);

export const TerminalReadTool = readonlyShellTool(
  Tool.make("terminal_read", {
    description: `Read the tail of a terminal's scrollback. Returns at most ${TERMINAL_READ_DEFAULT_LINES} trailing lines by default and never more than ${TERMINAL_READ_MAX_CHARACTERS} characters, keeping the newest output and setting truncated when anything was dropped. Escape sequences are stripped unless stripAnsi=false.`,
    parameters: TerminalReadToolInput,
    success: TerminalReadToolResult,
    failure: TerminalError,
    dependencies,
  }).annotate(Tool.Title, "Read terminal output"),
);

export const TerminalListTool = readonlyShellTool(
  Tool.make("terminal_list", {
    description:
      "List the live terminals for this thread with their label, status, working directory, worktree, and whether a subprocess is still running. Use it to find an existing terminal before opening another one.",
    parameters: TerminalListToolInput,
    success: TerminalListToolResult,
    failure: TerminalError,
    dependencies,
  }).annotate(Tool.Title, "List terminals"),
);

export const TerminalWaitTool = readonlyShellTool(
  Tool.make("terminal_wait", {
    description: `Block until a terminal has reported no running subprocess for quietMs, or until timeoutMs elapses. Returns idle=true when the command finished and timedOut=true when it is still running, and always returns within timeoutMs (default ${TERMINAL_WAIT_DEFAULT_TIMEOUT_MS} ms).`,
    parameters: TerminalWaitToolInput,
    success: TerminalWaitToolResult,
    failure: TerminalError,
    dependencies,
  }).annotate(Tool.Title, "Wait for terminal to go idle"),
);

export const TerminalCloseTool = shellTool(
  Tool.make("terminal_close", {
    description:
      "Close a terminal and kill its shell. Idempotent: closed=false means no live terminal had that id. Set deleteHistory=true to also drop the persisted scrollback.",
    parameters: TerminalCloseToolInput,
    success: TerminalCloseToolResult,
    failure: TerminalError,
    dependencies,
  }).annotate(Tool.Title, "Close terminal"),
);

export const TerminalToolkit = Toolkit.make(
  TerminalOpenTool,
  TerminalWriteTool,
  TerminalReadTool,
  TerminalListTool,
  TerminalWaitTool,
  TerminalCloseTool,
);
