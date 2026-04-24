import {
  NodeId,
  OrchestrationV2RuntimeRequest,
  ProviderApprovalDecision,
  ProviderUserInputAnswers,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import { Context, Schema } from "effect";
import type { Effect } from "effect";

export class RuntimeRequestOpenError extends Schema.TaggedErrorClass<RuntimeRequestOpenError>()(
  "RuntimeRequestOpenError",
  {
    requestId: RuntimeRequestId,
    nodeId: NodeId,
    kind: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Failed to open runtime request ${this.requestId} (${this.kind}).`;
  }
}

export class RuntimeRequestNotFoundError extends Schema.TaggedErrorClass<RuntimeRequestNotFoundError>()(
  "RuntimeRequestNotFoundError",
  {
    threadId: ThreadId,
    requestId: RuntimeRequestId,
  },
) {
  override get message(): string {
    return `Runtime request ${this.requestId} was not found in thread ${this.threadId}.`;
  }
}

export class RuntimeRequestRespondError extends Schema.TaggedErrorClass<RuntimeRequestRespondError>()(
  "RuntimeRequestRespondError",
  {
    threadId: ThreadId,
    requestId: RuntimeRequestId,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Failed to respond to runtime request ${this.requestId} in thread ${this.threadId}.`;
  }
}

export const RuntimeRequestServiceV2Error = Schema.Union([
  RuntimeRequestOpenError,
  RuntimeRequestNotFoundError,
  RuntimeRequestRespondError,
]);
export type RuntimeRequestServiceV2Error = typeof RuntimeRequestServiceV2Error.Type;

export interface RuntimeRequestServiceV2Shape {
  readonly open: (
    request: OrchestrationV2RuntimeRequest,
  ) => Effect.Effect<void, RuntimeRequestServiceV2Error>;
  readonly respond: (input: {
    readonly threadId: ThreadId;
    readonly requestId: RuntimeRequestId;
    readonly decision?: ProviderApprovalDecision;
    readonly answers?: ProviderUserInputAnswers;
    readonly response?: unknown;
  }) => Effect.Effect<OrchestrationV2RuntimeRequest, RuntimeRequestServiceV2Error>;
}

export class RuntimeRequestServiceV2 extends Context.Service<
  RuntimeRequestServiceV2,
  RuntimeRequestServiceV2Shape
>()("t3/orchestration-v2/RuntimeRequestService") {}
