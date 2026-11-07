import * as Threads from "../../../orchestration-v2/ThreadManagementService.ts";
import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import { Input } from "../../externalToolInput.ts";
import * as ExternalToolBroker from "../../ExternalToolBroker.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

export const ExternalToolToolkit = Toolkit.make(
  Tool.make("external_tool", {
    description:
      "Invoke an operation on a host-configured external tool target. The host signs verified identity. Child threads cannot invoke this tool.",
    parameters: Input,
    success: Schema.Record(Schema.String, Schema.Unknown),
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies: [
      Threads.ThreadManagementService,
      ExternalToolBroker.ExternalToolBroker,
      McpInvocationContext.McpInvocationContext,
    ],
  })
    .annotate(Tool.Destructive, true)
    .annotate(Tool.OpenWorld, true),
);
