import {
  ModelSelection,
  OrchestrationV2ContextHandoff,
  OrchestrationV2ThreadProjection,
  ProviderThreadId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { Context, Schema } from "effect";
import type { Effect } from "effect";

export const ProviderSwitchStrategyV2 = Schema.Literals([
  "resume_with_delta_handoff",
  "resume_with_full_handoff",
  "new_thread_with_full_handoff",
]);
export type ProviderSwitchStrategyV2 = typeof ProviderSwitchStrategyV2.Type;

export const ProviderSwitchPlanV2 = Schema.Struct({
  strategy: ProviderSwitchStrategyV2,
  targetProviderThreadId: Schema.NullOr(ProviderThreadId),
  handoff: Schema.NullOr(OrchestrationV2ContextHandoff),
});
export type ProviderSwitchPlanV2 = typeof ProviderSwitchPlanV2.Type;

export class ProviderSwitchPlanError extends Schema.TaggedErrorClass<ProviderSwitchPlanError>()(
  "ProviderSwitchPlanError",
  {
    threadId: ThreadId,
    targetRunId: RunId,
    targetProvider: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Failed to plan provider switch to ${this.targetProvider} for run ${this.targetRunId}.`;
  }
}

export class ProviderSwitchApplyError extends Schema.TaggedErrorClass<ProviderSwitchApplyError>()(
  "ProviderSwitchApplyError",
  {
    threadId: ThreadId,
    targetRunId: RunId,
    strategy: ProviderSwitchStrategyV2,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Failed to apply provider switch strategy ${this.strategy} for run ${this.targetRunId}.`;
  }
}

export const ProviderSwitchServiceV2Error = Schema.Union([
  ProviderSwitchPlanError,
  ProviderSwitchApplyError,
]);
export type ProviderSwitchServiceV2Error = typeof ProviderSwitchServiceV2Error.Type;

export interface ProviderSwitchServiceV2Shape {
  readonly plan: (input: {
    readonly projection: OrchestrationV2ThreadProjection;
    readonly targetRunId: RunId;
    readonly targetModelSelection: ModelSelection;
  }) => Effect.Effect<ProviderSwitchPlanV2, ProviderSwitchServiceV2Error>;
  readonly apply: (input: {
    readonly projection: OrchestrationV2ThreadProjection;
    readonly targetRunId: RunId;
    readonly targetModelSelection: ModelSelection;
    readonly plan: ProviderSwitchPlanV2;
  }) => Effect.Effect<ProviderSwitchPlanV2, ProviderSwitchServiceV2Error>;
}

export class ProviderSwitchServiceV2 extends Context.Service<
  ProviderSwitchServiceV2,
  ProviderSwitchServiceV2Shape
>()("t3/orchestration-v2/ProviderSwitchService") {}
