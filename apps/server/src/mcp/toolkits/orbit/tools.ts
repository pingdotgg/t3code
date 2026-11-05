import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import { Input } from "../../orbitInput.ts";
import * as OrbitBroker from "../../OrbitBroker.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

export const OrbitToolkit = Toolkit.make(
  Tool.make("orbit", {
    description:
      "Orbit planning: read your context, list/get tickets, propose/update/link work. Use the orbit skill. Identity comes from T3; omit threadId. Orchestrator create_ticket/start_thread need requestId. Subagents: orbit_context only.",
    parameters: Input,
    success: Schema.Record(Schema.String, Schema.Unknown),
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies: [OrbitBroker.OrbitBroker, McpInvocationContext.McpInvocationContext],
  })
    .annotate(Tool.Destructive, false)
    .annotate(Tool.OpenWorld, false),
);
