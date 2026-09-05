import {
  TerminalMcpAcceptedInputResult,
  TerminalMcpClearInput,
  TerminalMcpCloseInput,
  TerminalMcpCloseResult,
  TerminalMcpFailure,
  TerminalMcpListInput,
  TerminalMcpListResult,
  TerminalMcpOpenInput,
  TerminalMcpOpenResult,
  TerminalMcpReadInput,
  TerminalMcpReadResult,
  TerminalMcpResizeInput,
  TerminalMcpRestartInput,
  TerminalMcpStateResult,
  TerminalMcpWriteInput,
} from "@t3tools/contracts";
import * as Tool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";

import { McpInvocationContext } from "../../McpInvocationContext.ts";
import { TerminalMcpService } from "../../TerminalMcpService.ts";

const dependencies = [McpInvocationContext, TerminalMcpService];

export const TerminalListTool = Tool.make("t3_terminal_list", {
  description:
    "List already-loaded managed terminals for this project. The target thread defaults to the calling thread and must belong to the same project. This read never opens a shell or loads persisted history. Evicted and never-loaded sessions are absent.",
  parameters: TerminalMcpListInput,
  success: TerminalMcpListResult,
  failure: TerminalMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "List managed terminals")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const TerminalReadTool = Tool.make("t3_terminal_read", {
  description:
    "Read a bounded tail snapshot from one already-loaded managed terminal. The result reports retained character offsets, truncation, and the terminal event sequence. This read never attaches, starts, restarts, or loads persisted history.",
  parameters: TerminalMcpReadInput,
  success: TerminalMcpReadResult,
  failure: TerminalMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Read managed terminal output")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const TerminalOpenTool = Tool.make("t3_terminal_open", {
  description:
    "Open a managed terminal with an explicit terminalId in the target thread's current worktree or project workspace. An existing running terminal is returned unchanged. An existing exited or failed terminal is not restarted; call t3_terminal_restart explicitly. Both calling and target threads must use full-access runtime mode and default interaction mode.",
  parameters: TerminalMcpOpenInput,
  success: TerminalMcpOpenResult,
  failure: TerminalMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Open a managed terminal")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

export const TerminalWriteTool = Tool.make("t3_terminal_write", {
  description:
    "Write bytes to one running managed terminal. Success means the PTY accepted the bytes, not that a shell command succeeded. This operation is non-idempotent and requires both calling and target threads to use full-access runtime mode and default interaction mode.",
  parameters: TerminalMcpWriteInput,
  success: TerminalMcpAcceptedInputResult,
  failure: TerminalMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Write to a managed terminal")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

export const TerminalResizeTool = Tool.make("t3_terminal_resize", {
  description:
    "Resize one running managed terminal. Both calling and target threads must use full-access runtime mode and default interaction mode.",
  parameters: TerminalMcpResizeInput,
  success: TerminalMcpStateResult,
  failure: TerminalMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Resize a managed terminal")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const TerminalClearTool = Tool.make("t3_terminal_clear", {
  description:
    "Clear the retained output of one loaded managed terminal without closing it. Both calling and target threads must use full-access runtime mode and default interaction mode.",
  parameters: TerminalMcpClearInput,
  success: TerminalMcpStateResult,
  failure: TerminalMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Clear managed terminal output")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const TerminalRestartTool = Tool.make("t3_terminal_restart", {
  description:
    "Restart an existing managed terminal in the target thread's current worktree or project workspace. Restart clears retained output and is non-idempotent. Both calling and target threads must use full-access runtime mode and default interaction mode.",
  parameters: TerminalMcpRestartInput,
  success: TerminalMcpStateResult,
  failure: TerminalMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Restart a managed terminal")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

export const TerminalCloseTool = Tool.make("t3_terminal_close", {
  description:
    "Close one explicit managed terminal. This tool never closes every terminal by omission. Both calling and target threads must use full-access runtime mode and default interaction mode.",
  parameters: TerminalMcpCloseInput,
  success: TerminalMcpCloseResult,
  failure: TerminalMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Close a managed terminal")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

export const TerminalToolkit = Toolkit.make(
  TerminalListTool,
  TerminalReadTool,
  TerminalOpenTool,
  TerminalWriteTool,
  TerminalResizeTool,
  TerminalClearTool,
  TerminalRestartTool,
  TerminalCloseTool,
);
