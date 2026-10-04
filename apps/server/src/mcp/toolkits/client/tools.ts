import { ClientIntentThreadPanel, OrchestratorMcpFailure, ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";
import * as ClientIntents from "../../../clientIntents.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const ClientOpenThreadTool = Tool.make("t3_client_open_thread", {
  description:
    "Show a thread in the user's T3 Code app (omit threadId for this thread), optionally with its diff or files panel open. The desktop app window the user focused last navigates even while another app has focus, and any focused web or desktop window does too; other open devices stay put and mobile does not respond. delivered is false when no client is connected; true means a client received the request.",
  parameters: Schema.Struct({
    threadId: Schema.optional(ThreadId),
    panel: Schema.optional(ClientIntentThreadPanel),
  }),
  success: Schema.Struct({
    threadId: ThreadId,
    delivered: Schema.Boolean,
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ClientIntents.ClientIntents,
  ],
})
  .annotate(Tool.Title, "Open thread in app")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const ClientToolkit = Toolkit.make(ClientOpenThreadTool);
