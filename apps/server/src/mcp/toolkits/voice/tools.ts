import { OrchestratorMcpFailure, VoiceMode } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../../../serverSettings.ts";

const VoiceModeTool = Tool.make("t3_voice_mode", {
  description:
    "Turn voice on or off for this thread, only when the user asks. On turns on one-way voice: T3 Code reads this thread's replies aloud and marks the user's typed messages with 🔊. On keeps a two-way voice the user chose, which also sends what they say marked with 🎙. Voice belongs to one thread at a time.",
  parameters: Schema.Struct({ action: Schema.Literals(["on", "off", "toggle"]) }),
  success: Schema.Struct({ mode: VoiceMode }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ServerSettings.ServerSettingsService,
  ],
})
  .annotate(Tool.Title, "Turn voice on or off")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

export const VoiceToolkit = Toolkit.make(VoiceModeTool);
