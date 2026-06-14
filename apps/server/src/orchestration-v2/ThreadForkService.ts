import {
  OrchestrationV2AppThread,
  OrchestrationV2ThreadForkSourcePoint,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Schema from "effect/Schema";
import type * as Effect from "effect/Effect";

export class ThreadForkPlanError extends Schema.TaggedErrorClass<ThreadForkPlanError>()(
  "ThreadForkPlanError",
  {
    targetThreadId: ThreadId,
    sourcePoint: OrchestrationV2ThreadForkSourcePoint,
    cause: Schema.optional(Schema.Defect()),
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
    sourcePoint: OrchestrationV2ThreadForkSourcePoint,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to apply fork into thread ${this.targetThreadId}.`;
  }
}

export const ThreadForkServiceV2Error = Schema.Union([ThreadForkPlanError, ThreadForkApplyError]);
export type ThreadForkServiceV2Error = typeof ThreadForkServiceV2Error.Type;

export interface ThreadForkPlanV2 {
  readonly sourcePoint: OrchestrationV2ThreadForkSourcePoint;
  readonly targetThreadId: ThreadId;
  readonly targetThread: OrchestrationV2AppThread;
}

export interface ThreadForkServiceV2Shape {
  readonly plan: (input: {
    readonly sourcePoint: OrchestrationV2ThreadForkSourcePoint;
    readonly targetThreadId: ThreadId;
  }) => Effect.Effect<ThreadForkPlanV2, ThreadForkServiceV2Error>;
  readonly apply: (
    plan: ThreadForkPlanV2,
  ) => Effect.Effect<ThreadForkPlanV2, ThreadForkServiceV2Error>;
}

export class ThreadForkServiceV2 extends Context.Service<
  ThreadForkServiceV2,
  ThreadForkServiceV2Shape
>()("t3/orchestration-v2/ThreadForkService/ThreadForkServiceV2") {}
