import {
  CheckpointId,
  CheckpointScopeId,
  NodeId,
  OrchestrationV2Checkpoint,
  OrchestrationV2CheckpointScope,
  OrchestrationV2ExecutionNode,
  OrchestrationV2Run,
  OrchestrationV2ThreadProjection,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { Context, Schema } from "effect";
import type { Effect } from "effect";

export class CheckpointPolicyPrepareRunError extends Schema.TaggedErrorClass<CheckpointPolicyPrepareRunError>()(
  "CheckpointPolicyPrepareRunError",
  {
    threadId: ThreadId,
    runId: RunId,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Failed to prepare checkpoint policy for run ${this.runId}.`;
  }
}

export class CheckpointPolicyFinalizeNodeError extends Schema.TaggedErrorClass<CheckpointPolicyFinalizeNodeError>()(
  "CheckpointPolicyFinalizeNodeError",
  {
    threadId: ThreadId,
    nodeId: NodeId,
    scopeId: Schema.optional(CheckpointScopeId),
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Failed to finalize checkpoint policy for node ${this.nodeId}.`;
  }
}

export class CheckpointPolicyRollbackError extends Schema.TaggedErrorClass<CheckpointPolicyRollbackError>()(
  "CheckpointPolicyRollbackError",
  {
    threadId: ThreadId,
    scopeId: CheckpointScopeId,
    checkpointId: CheckpointId,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Failed to apply checkpoint rollback ${this.checkpointId} for scope ${this.scopeId}.`;
  }
}

export const CheckpointPolicyV2Error = Schema.Union([
  CheckpointPolicyPrepareRunError,
  CheckpointPolicyFinalizeNodeError,
  CheckpointPolicyRollbackError,
]);
export type CheckpointPolicyV2Error = typeof CheckpointPolicyV2Error.Type;

export interface CheckpointPolicyV2Shape {
  readonly prepareRun: (input: {
    readonly projection: OrchestrationV2ThreadProjection;
    readonly run: OrchestrationV2Run;
  }) => Effect.Effect<ReadonlyArray<OrchestrationV2CheckpointScope>, CheckpointPolicyV2Error>;
  readonly finalizeNode: (input: {
    readonly projection: OrchestrationV2ThreadProjection;
    readonly node: OrchestrationV2ExecutionNode;
  }) => Effect.Effect<ReadonlyArray<OrchestrationV2Checkpoint>, CheckpointPolicyV2Error>;
  readonly rollback: (input: {
    readonly projection: OrchestrationV2ThreadProjection;
    readonly scopeId: CheckpointScopeId;
    readonly checkpointId: CheckpointId;
  }) => Effect.Effect<ReadonlyArray<OrchestrationV2Checkpoint>, CheckpointPolicyV2Error>;
}

export class CheckpointPolicyV2 extends Context.Service<
  CheckpointPolicyV2,
  CheckpointPolicyV2Shape
>()("t3/orchestration-v2/CheckpointPolicy") {}
