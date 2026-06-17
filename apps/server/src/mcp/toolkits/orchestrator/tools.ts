import {
  OrchestratorMcpCapabilitiesResult,
  OrchestratorMcpCreateThreadsInput,
  OrchestratorMcpCreateThreadsResult,
  OrchestratorMcpDelegateTaskInput,
  OrchestratorMcpDelegateTaskResult,
  OrchestratorMcpFailure,
  OrchestratorMcpTaskCancelInput,
  OrchestratorMcpTaskCancelResult,
  OrchestratorMcpTaskStatusInput,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { OrchestratorMcpService } from "../../OrchestratorMcpService.ts";

const dependencies = [McpInvocationContext.McpInvocationContext, OrchestratorMcpService];

export const OrchestratorCapabilitiesTool = Tool.make("orchestrator_capabilities", {
  description:
    "List the V2 provider instances, models, inherited runtime settings, and app-owned orchestration features available to this T3 thread.",
  success: OrchestratorMcpCapabilitiesResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Get orchestration capabilities")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const DelegateTaskTool = Tool.make("delegate_task", {
  description:
    "Create a T3-owned child agent thread and run it with only the supplied task prompt, without copying parent conversation history. Provider, model, runtime mode, and interaction mode inherit from the parent unless overridden. Prefer mode='async' and poll task_status for long work; mode='wait' blocks until completion or timeout.",
  parameters: OrchestratorMcpDelegateTaskInput,
  success: OrchestratorMcpDelegateTaskResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Delegate a child task")
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);

export const TaskStatusTool = Tool.make("task_status", {
  description:
    "Read the latest durable state and final summary for a T3-owned delegated task created by this parent thread.",
  parameters: OrchestratorMcpTaskStatusInput,
  success: OrchestratorMcpDelegateTaskResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Get delegated task status")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const TaskCancelTool = Tool.make("task_cancel", {
  description:
    "Request interruption of an active T3-owned delegated task. Completed tasks are returned unchanged.",
  parameters: OrchestratorMcpTaskCancelInput,
  success: OrchestratorMcpTaskCancelResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Cancel delegated task")
  .annotate(Tool.Destructive, true);

export const CreateThreadsTool = Tool.make("create_threads", {
  description:
    "Create one or more ordinary top-level T3 V2 threads. Each entry may have its own prompt, title, provider instance or driver, model, runtime mode, and interaction mode. Omitted provider/model/settings inherit from the calling thread; entries without prompts create empty threads.",
  parameters: OrchestratorMcpCreateThreadsInput,
  success: OrchestratorMcpCreateThreadsResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Create T3 threads")
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);

export const OrchestratorToolkit = Toolkit.make(
  OrchestratorCapabilitiesTool,
  DelegateTaskTool,
  TaskStatusTool,
  TaskCancelTool,
  CreateThreadsTool,
);
