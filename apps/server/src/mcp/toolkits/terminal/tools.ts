import {
  OrchestratorMcpFailure,
  TerminalMcpCloseInput,
  TerminalMcpCloseResult,
  TerminalMcpFailure,
  TerminalMcpListResult,
  TerminalMcpReadInput,
  TerminalMcpReadResult,
  TerminalMcpSendInput,
  TerminalMcpSendResult,
  TerminalMcpStartInput,
  TerminalMcpStartResult,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as TerminalMcpService from "../../TerminalMcpService.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  TerminalMcpService.TerminalMcpService,
];

const TerminalToolFailure = Schema.Union([TerminalMcpFailure, OrchestratorMcpFailure]);

const TerminalStartTool = Tool.make("terminal_start", {
  description:
    "Open a shell in this thread's workspace that the user sees and can take over. Optionally run `command`. For interactive programs, servers, and long jobs; your own shell tool suits one-off commands.",
  parameters: TerminalMcpStartInput,
  success: TerminalMcpStartResult,
  failure: TerminalToolFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Start a shared terminal")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

const TerminalSendTool = Tool.make("terminal_send", {
  description:
    "Type raw input into a terminal you control. Refused while the user has control. Read the reply with `terminal_read` from the returned `cursor`.",
  parameters: TerminalMcpSendInput,
  success: TerminalMcpSendResult,
  failure: TerminalToolFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Send terminal input")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

const TerminalReadTool = Tool.make("terminal_read", {
  description:
    "Read a terminal of this thread as plain text, after `cursor` or its tail. Optionally wait for a match, exit, or quiet. Pass the returned `cursor` next time.",
  parameters: TerminalMcpReadInput,
  success: TerminalMcpReadResult,
  failure: TerminalToolFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Read terminal output")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

const TerminalListTool = Tool.make("terminal_list", {
  description:
    "List this thread's terminals, including ones the user opened, and who controls each.",
  success: TerminalMcpListResult,
  failure: TerminalToolFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "List terminals")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

const TerminalCloseTool = Tool.make("terminal_close", {
  description: "Close a terminal you control and stop what runs in it.",
  parameters: TerminalMcpCloseInput,
  success: TerminalMcpCloseResult,
  failure: TerminalToolFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Close a terminal")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

export const TerminalToolkit = Toolkit.make(
  TerminalStartTool,
  TerminalSendTool,
  TerminalReadTool,
  TerminalListTool,
  TerminalCloseTool,
);
