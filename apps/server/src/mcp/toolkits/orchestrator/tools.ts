import {
  OrchestratorMcpCapabilitiesResult,
  OrchestratorMcpCreateThreadsInput,
  OrchestratorMcpCreateThreadsResult,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as OrchestrationEngine from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ProviderRegistry from "../../../provider/Services/ProviderRegistry.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  OrchestrationEngine.OrchestrationEngineService,
  ProjectionSnapshotQuery.ProjectionSnapshotQuery,
  ProviderRegistry.ProviderRegistry,
];

// Names, schemas, and descriptions follow the Orchestrator V2 toolkit (#2829),
// minus references to tools that only exist there, so agent prompts and
// habits carry over when V2 replaces this toolkit.

const OrchestratorCapabilitiesTool = Tool.make("orchestrator_capabilities", {
  description:
    "List the provider instances, models, and inherited runtime settings available to this T3 thread, and which orchestration features this server supports. Use it before create_threads to pick a providerInstanceId, model, or model options.",
  success: OrchestratorMcpCapabilitiesResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Get orchestration capabilities")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const CreateThreadsTool = Tool.make("create_threads", {
  description:
    "Create one or more ORDINARY TOP-LEVEL T3 conversations. This is not delegation and does not create child agents/subagents. For delegated work, prefer native subagents within the current provider. Use create_threads only when the user requests separate/new/top-level threads or conversations. Each entry may override provider, model, options, runtime mode, and interaction mode; omitted settings inherit. Project, branch, and worktree always inherit and cannot be overridden, so threads that edit this checkout at the same time can collide: split the work by files. An entry with a prompt starts working immediately; an entry without one waits for the user. New threads run on their own and do not report back to this thread.",
  parameters: OrchestratorMcpCreateThreadsInput,
  success: OrchestratorMcpCreateThreadsResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Create T3 threads")
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);

export const OrchestratorToolkit = Toolkit.make(OrchestratorCapabilitiesTool, CreateThreadsTool);
