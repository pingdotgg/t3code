import {
  OrchestrationV2AppThread,
  OrchestrationV2Command,
  OrchestrationV2ThreadProjection,
  NodeId,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { Context, Schema } from "effect";
import type { Effect } from "effect";

const ThreadForkSourceV2 = Schema.Union([
  Schema.Struct({ type: Schema.Literal("run"), threadId: ThreadId, runId: RunId }),
  Schema.Struct({ type: Schema.Literal("node"), nodeId: NodeId }),
  Schema.Struct({
    type: Schema.Literal("provider_thread"),
    providerThreadId: ProviderThreadId,
    providerTurnId: Schema.optional(ProviderTurnId),
  }),
]);

export class ThreadForkPlanError extends Schema.TaggedErrorClass<ThreadForkPlanError>()(
  "ThreadForkPlanError",
  {
    targetThreadId: ThreadId,
    source: ThreadForkSourceV2,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Failed to plan fork into thread ${this.targetThreadId}.`;
  }
}

export class ThreadForkApplyError extends Schema.TaggedErrorClass<ThreadForkApplyError>()(
  "ThreadForkApplyError",
  {
    targetThreadId: ThreadId,
    source: ThreadForkSourceV2,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Failed to apply fork into thread ${this.targetThreadId}.`;
  }
}

export const ThreadForkServiceV2Error = Schema.Union([ThreadForkPlanError, ThreadForkApplyError]);
export type ThreadForkServiceV2Error = typeof ThreadForkServiceV2Error.Type;

export interface ThreadForkPlanV2 {
  readonly source: Extract<OrchestrationV2Command, { readonly type: "thread.fork" }>["source"];
  readonly targetThreadId: ThreadId;
  readonly targetThread: OrchestrationV2AppThread;
}

export interface ThreadForkServiceV2Shape {
  readonly plan: (input: {
    readonly projection: OrchestrationV2ThreadProjection;
    readonly source: Extract<OrchestrationV2Command, { readonly type: "thread.fork" }>["source"];
    readonly targetThreadId: ThreadId;
  }) => Effect.Effect<ThreadForkPlanV2, ThreadForkServiceV2Error>;
  readonly apply: (
    plan: ThreadForkPlanV2,
  ) => Effect.Effect<ThreadForkPlanV2, ThreadForkServiceV2Error>;
}

export class ThreadForkServiceV2 extends Context.Service<
  ThreadForkServiceV2,
  ThreadForkServiceV2Shape
>()("t3/orchestration-v2/ThreadForkService") {}
