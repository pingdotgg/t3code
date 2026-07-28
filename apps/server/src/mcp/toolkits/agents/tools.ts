import {
  BranchThreadError,
  BranchThreadInput,
  BranchThreadResult,
  DelegateError,
  DelegateTaskInput,
  DelegateTaskResult,
  DelegateTaskStatusInput,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { DelegateCoordinator } from "./DelegateCoordinator.ts";
import { ThreadBranchCoordinator } from "./ThreadBranchCoordinator.ts";

const dependencies = [McpInvocationContext.McpInvocationContext, DelegateCoordinator];

export const DelegateTaskTool = Tool.make("delegate_task", {
  description:
    "Start one self-contained task on a background agent inside this thread's project and worktree. Set role to explore, implement, or verify so SurgeCode can apply the user's configured workflow model; an unconfigured role inherits the Advisor executor model or this session's model. Returns immediately with a task id and running status; call wait_for_delegate with that task id until it completes, then use the returned result. The agent does not see this conversation, so include everything it needs in the prompt. Advisor threads use their configured executor sub-agent limit, and delegated agents cannot delegate further.",
  parameters: DelegateTaskInput,
  success: DelegateTaskResult,
  failure: DelegateError,
  dependencies,
})
  .annotate(Tool.Title, "Delegate task to background agent")
  .annotate(Tool.OpenWorld, true)
  .annotate(Tool.Destructive, true);

export const WaitForDelegateTool = Tool.make("wait_for_delegate", {
  description:
    "Wait briefly for a delegated task and return its current status. If it is still running, call this tool again. When completed, the result contains the delegated agent's final response. This bounded wait is the reliable way to collect delegate_task output without a long-lived MCP request.",
  parameters: DelegateTaskStatusInput,
  success: DelegateTaskResult,
  failure: DelegateError,
  dependencies,
})
  .annotate(Tool.Title, "Wait for delegated agent")
  .annotate(Tool.OpenWorld, false)
  .annotate(Tool.Destructive, false);

export const BranchThreadTool = Tool.make("branch_thread", {
  description:
    "Create a new independent top-level thread from the current conversation. The new thread inherits a bounded snapshot of this conversation, its project, provider/model settings, permissions, and workspace, but starts a separate provider session. Use this when the user asks to explore or continue an alternative path in a new thread. Returns the new thread id; it does not start a turn in that thread.",
  parameters: BranchThreadInput,
  success: BranchThreadResult,
  failure: BranchThreadError,
  dependencies: [McpInvocationContext.McpInvocationContext, ThreadBranchCoordinator],
})
  .annotate(Tool.Title, "Branch current thread")
  .annotate(Tool.OpenWorld, false)
  .annotate(Tool.Destructive, false);

export const DelegateToolkit = Toolkit.make(
  DelegateTaskTool,
  WaitForDelegateTool,
  BranchThreadTool,
);
