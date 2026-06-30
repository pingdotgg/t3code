import type { StepOutcome } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { WorkflowEventStoreError } from "./Errors.ts";
import type { StepExecutionContext } from "./StepExecutor.ts";
import type { WorktreeHandle } from "./WorktreePort.ts";

export type ScriptStep = Extract<StepExecutionContext["step"], { readonly type: "script" }>;

export interface ScriptStepExecutionInput {
  readonly ctx: StepExecutionContext;
  readonly step: ScriptStep;
  readonly worktree: WorktreeHandle;
}

export interface ScriptStepExecutorShape {
  readonly execute: (
    input: ScriptStepExecutionInput,
  ) => Effect.Effect<StepOutcome, WorkflowEventStoreError>;
}

export class ScriptStepExecutor extends Context.Service<
  ScriptStepExecutor,
  ScriptStepExecutorShape
>()("t3/workflow/Services/ScriptStepExecutor") {}
