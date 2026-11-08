import {
  OrchestratorMcpEnvironmentTarget,
  OrchestratorMcpFailure,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  WorktreeMcpFailure,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool } from "effect/ai";

const SandboxToolFailure = Schema.Union([WorktreeMcpFailure, OrchestratorMcpFailure]);

export const PrepareSandboxBranchTool = Tool.make("t3_worktree_prepare_sandbox", {
  description:
    "Internal to sandbox handoff: create and switch to a branch in a freshly forked sandbox, keeping copied uncommitted files.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    projectId: ProjectId,
    branch: TrimmedNonEmptyString,
  }),
  success: Schema.Struct({ branch: TrimmedNonEmptyString }),
  failure: SandboxToolFailure,
  failureMode: "return",
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true);

export const RunSandboxSetupTool = Tool.make("t3_worktree_run_sandbox_setup", {
  description:
    "Internal to sandbox handoff: run the project setup script once on an idle child thread and wait for it. A failed or interrupted setup blocks continuation and is not run again.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    projectId: ProjectId,
    threadId: ThreadId,
  }),
  success: Schema.Struct({ completed: Schema.Literal(true) }),
  failure: SandboxToolFailure,
  failureMode: "return",
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true);
