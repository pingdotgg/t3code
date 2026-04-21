import {
  OrchestrationV2ContextHandoff,
  ProviderThreadId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { Context, Schema } from "effect";
import type { Effect } from "effect";

export class ContextHandoffPrepareError extends Schema.TaggedErrorClass<ContextHandoffPrepareError>()(
  "ContextHandoffPrepareError",
  {
    threadId: ThreadId,
    targetRunId: RunId,
    fromProviderThreadIds: Schema.Array(ProviderThreadId),
    toProviderThreadId: ProviderThreadId,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Failed to prepare context handoff for run ${this.targetRunId} in thread ${this.threadId}.`;
  }
}

export const ContextHandoffServiceV2Error = Schema.Union([ContextHandoffPrepareError]);
export type ContextHandoffServiceV2Error = typeof ContextHandoffServiceV2Error.Type;

export interface ContextHandoffServiceV2Shape {
  readonly prepare: (input: {
    readonly threadId: ThreadId;
    readonly targetRunId: RunId;
    readonly fromProviderThreadIds: ReadonlyArray<ProviderThreadId>;
    readonly toProviderThreadId: ProviderThreadId;
  }) => Effect.Effect<OrchestrationV2ContextHandoff, ContextHandoffServiceV2Error>;
}

export class ContextHandoffServiceV2 extends Context.Service<
  ContextHandoffServiceV2,
  ContextHandoffServiceV2Shape
>()("t3/orchestration-v2/Services/ContextHandoffService") {}
