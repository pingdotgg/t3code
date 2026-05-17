import {
  ApprovalRequestId,
  RuntimeRequestId,
  type ProviderApprovalDecision,
  type ThreadId,
  type TurnId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import type * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import { resolveAcpPermissionOutcome } from "../../acp/AcpAdapterSupport.ts";
import {
  makeAcpRequestOpenedEvent,
  makeAcpRequestResolvedEvent,
} from "../../acp/AcpCoreRuntimeEvents.ts";
import { parsePermissionRequest } from "../../acp/AcpRuntimeModel.ts";

import type { AcpRegistryHandlerContext, PendingApproval } from "./types.ts";

export function buildPermissionHandler(input: {
  readonly threadId: ThreadId;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly getActiveTurnId: () => TurnId | undefined;
  readonly context: AcpRegistryHandlerContext;
}): (
  params: EffectAcpSchema.RequestPermissionRequest,
) => Effect.Effect<EffectAcpSchema.RequestPermissionResponse, EffectAcpErrors.AcpError> {
  return (params) =>
    Effect.gen(function* () {
      const permissionRequest = parsePermissionRequest(params);
      const requestId = yield* input.context.makeApprovalRequestId();
      const runtimeRequestId = RuntimeRequestId.make(requestId);
      const decision = yield* Deferred.make<ProviderApprovalDecision>();
      input.pendingApprovals.set(requestId, { decision });
      yield* input.context.offerRuntimeEvent(
        makeAcpRequestOpenedEvent({
          stamp: yield* input.context.makeEventStamp(),
          provider: input.context.provider,
          threadId: input.threadId,
          turnId: input.getActiveTurnId(),
          requestId: runtimeRequestId,
          permissionRequest,
          detail: permissionRequest.detail ?? "Permission requested",
          args: params,
          source: "acp.jsonrpc",
          method: "session/request_permission",
          rawPayload: params,
        }),
      );
      const resolved = yield* Deferred.await(decision);
      input.pendingApprovals.delete(requestId);
      yield* input.context.offerRuntimeEvent(
        makeAcpRequestResolvedEvent({
          stamp: yield* input.context.makeEventStamp(),
          provider: input.context.provider,
          threadId: input.threadId,
          turnId: input.getActiveTurnId(),
          requestId: runtimeRequestId,
          permissionRequest,
          decision: resolved,
        }),
      );
      return {
        outcome: resolveAcpPermissionOutcome(resolved, params.options),
      };
    });
}
