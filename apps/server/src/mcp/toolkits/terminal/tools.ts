import { TerminalSessionSnapshot, TerminalSummary } from "@t3tools/contracts";
import { Schema } from "effect";
import { Tool, Toolkit } from "effect/unstable/ai";

import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { TerminalManager } from "../../../terminal/Services/Manager.ts";
import { McpInvocationContext } from "../../McpInvocationContext.ts";

export class TerminalToolError extends Schema.TaggedErrorClass<TerminalToolError>()(
  "TerminalToolError",
  { message: Schema.String },
) {}

const dependencies = [McpInvocationContext, TerminalManager, ProjectionSnapshotQuery];
const TerminalId = Schema.String.check(Schema.isPattern(/^agent-[a-z0-9-]{1,100}$/));
const selector = Schema.Struct({ terminalId: TerminalId });

export const TerminalToolkit = Toolkit.make(
  Tool.make("terminal_start", {
    description:
      "Start a foreground command in a new T3-managed terminal owned by this chat and its workspace. Runs non-interactively with /bin/sh -c (cmd.exe /d /s /c on Windows), without interactive shell startup files. Use for dev servers and watchers that must stay alive across assistant turns, instead of an attached provider bash/terminal job. Returns promptly; running means the terminal exists, not that the service is ready. Verify readiness with terminal_read and a health request. Keep the returned terminalId to read or stop it. Do not use &, nohup, or detach. On an ambiguous response call terminal_list before retrying. Terminals survive provider completion/interruption but close with chat archive/deletion or T3 shutdown.",
    parameters: Schema.Struct({
      command: Schema.String.check(Schema.isNonEmpty()).check(Schema.isMaxLength(65_535)),
    }),
    success: TerminalSessionSnapshot,
    failure: TerminalToolError,
    dependencies,
  })
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, false),
  Tool.make("terminal_list", {
    description:
      "List this chat's agent-managed terminals without opening or restarting anything. Reuse retained servers before starting replacements. Terminal status describes the shell; hasRunningSubprocess indicates attached work, not service readiness.",
    parameters: Schema.Struct({}),
    success: Schema.Array(TerminalSummary),
    failure: TerminalToolError,
    dependencies,
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true),
  Tool.make("terminal_read", {
    description:
      "Read a bounded tail of output and status from one of this chat's agent-managed terminals. Returns immediately without starting or restarting a process; use health checks to establish service readiness.",
    parameters: selector,
    success: TerminalSessionSnapshot,
    failure: TerminalToolError,
    dependencies,
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true),
  Tool.make("terminal_stop", {
    description:
      "Close exactly one agent-managed terminal belonging to this chat and terminate its process tree. Use when its server is no longer needed, not merely because an assistant turn ends. Does not stop other terminals or mark the chat complete.",
    parameters: selector,
    success: Schema.Struct({ terminalId: TerminalId, closed: Schema.Boolean }),
    failure: TerminalToolError,
    dependencies,
  })
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Destructive, true)
    .annotate(Tool.Idempotent, false),
);
