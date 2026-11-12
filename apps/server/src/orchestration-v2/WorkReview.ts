import {
  buildPermissionRequestRouting,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2TurnItem,
  type PermissionRoutingPolicy,
  type ProviderApprovalOption,
  type ProviderDriverKind,
  type ThreadId,
  type WorkReviewDeliverable,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";

const WORK_REVIEW_OPTIONS = [
  { decision: "decline", label: "Decline" },
  { decision: "accept", label: "Accept" },
] satisfies ReadonlyArray<ProviderApprovalOption>;

export type WorkReviewRequestInput = {
  readonly threadId: ThreadId;
  readonly criteria: string;
  readonly name?: string;
  readonly note?: string;
  readonly deliverable?: WorkReviewDeliverable;
  readonly driver: ProviderDriverKind;
  readonly ordinal: number;
  readonly policy: PermissionRoutingPolicy;
  readonly now: DateTime.Utc;
  readonly idAllocator: IdAllocator.IdAllocatorV2["Service"];
};

export type WorkReviewArtifacts = {
  readonly node: OrchestrationV2ExecutionNode;
  readonly request: OrchestrationV2RuntimeRequest;
  readonly turnItem: OrchestrationV2TurnItem;
};

/**
 * Builds the three projection updates for a work-review approval card.
 * Decline resolves the ask (settlement unblocks); acceptance is the Accept decision.
 * Re-request creates a new pending review after a decline.
 */
export const buildWorkReviewArtifacts = Effect.fn("WorkReview.buildArtifacts")(function* (
  input: WorkReviewRequestInput,
) {
  const requestId = yield* input.idAllocator.allocate.runtimeRequest({
    driver: input.driver,
    nativeRequestId: `work-review:${input.threadId}`,
  });
  const nodeId = input.idAllocator.derive.approvalNode({ requestId });
  const turnItemId = input.idAllocator.derive.approvalTurnItem({ requestId });
  const prompt =
    input.name === undefined || input.name.trim() === ""
      ? input.criteria
      : input.criteria.trim() === ""
        ? input.name
        : `${input.name}\n\n${input.criteria}`;
  const reason = input.note?.trim() ? input.note : undefined;

  const node: OrchestrationV2ExecutionNode = {
    id: nodeId,
    threadId: input.threadId,
    runId: null,
    parentNodeId: null,
    rootNodeId: nodeId,
    kind: "approval_request",
    status: "waiting",
    countsForRun: false,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    runtimeRequestId: requestId,
    checkpointScopeId: null,
    startedAt: input.now,
    completedAt: null,
  };

  const request: OrchestrationV2RuntimeRequest = {
    id: requestId,
    nodeId,
    providerTurnId: null,
    nativeRequestRef: null,
    kind: "work_review",
    status: "pending",
    responseCapability: { type: "orchestration" },
    createdAt: input.now,
    resolvedAt: null,
    routing: buildPermissionRequestRouting(input.policy, input.now),
    ...(input.deliverable === undefined ? {} : { deliverable: input.deliverable }),
  };

  const turnItem: OrchestrationV2TurnItem = {
    id: turnItemId,
    threadId: input.threadId,
    runId: null,
    nodeId,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: input.ordinal,
    status: "waiting",
    title: input.name ?? "Review",
    startedAt: input.now,
    completedAt: null,
    updatedAt: input.now,
    type: "approval_request",
    requestId,
    requestKind: "work_review",
    prompt,
    ...(reason === undefined ? {} : { reason }),
    options: WORK_REVIEW_OPTIONS,
  };

  return { node, request, turnItem } satisfies WorkReviewArtifacts;
});
