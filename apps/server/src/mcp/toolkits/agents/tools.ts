import { DelegateError, DelegateTaskInput, DelegateTaskResult } from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { DelegateCoordinator } from "./DelegateCoordinator.ts";

const dependencies = [McpInvocationContext.McpInvocationContext, DelegateCoordinator];

export const DelegateTaskTool = Tool.make("delegate_task", {
  description:
    "Delegate one self-contained task to a background agent that runs on this session's own provider and model, inside this thread's project and worktree. Blocks until the agent finishes and returns its final message. The agent does not see this conversation — include everything it needs in the prompt. At most 3 delegated agents may run concurrently per session, and delegated agents cannot delegate further.",
  parameters: DelegateTaskInput,
  success: DelegateTaskResult,
  failure: DelegateError,
  dependencies,
})
  .annotate(Tool.Title, "Delegate task to background agent")
  .annotate(Tool.OpenWorld, true)
  .annotate(Tool.Destructive, true);

export const DelegateToolkit = Toolkit.make(DelegateTaskTool);
