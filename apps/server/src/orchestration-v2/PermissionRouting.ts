import {
  buildPermissionRequestRouting,
  DEFAULT_PERMISSION_ROUTING_POLICY,
  isPermissionApprovalKind,
  nobodyPermitResolvedBy,
  shouldPermitWhenNobody,
  type OrchestrationV2RuntimeRequest,
  type PermissionRequestResolvedBy,
  type PermissionRequestRouting,
  type PermissionRoutingPolicy,
  type PermissionRoutingSessionSnapshot,
  type RuntimeRequestId,
  type ServerSettings,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ServerSettingsService from "../serverSettings.ts";

/** Optional hook so ingest can ask the runtime to reconsider permit-when-nobody without a layer cycle. */
export interface PermissionRoutingHooksShape {
  readonly onPendingApprovalRouted: (input: {
    readonly threadId: ThreadId;
    readonly requestId: RuntimeRequestId;
  }) => Effect.Effect<void>;
}

export class PermissionRoutingHooks extends Context.Service<
  PermissionRoutingHooks,
  PermissionRoutingHooksShape
>()("t3/orchestration-v2/PermissionRouting/PermissionRoutingHooks") {}

export const stampPendingApprovalRouting = (input: {
  readonly request: OrchestrationV2RuntimeRequest;
  readonly policy: PermissionRoutingPolicy;
  readonly now: DateTime.Utc;
}): OrchestrationV2RuntimeRequest => {
  if (input.request.status !== "pending") return input.request;
  if (!isPermissionApprovalKind(input.request.kind)) return input.request;
  if (input.request.routing !== undefined) return input.request;
  return {
    ...input.request,
    routing: buildPermissionRequestRouting(input.policy, input.now),
  };
};

export const permissionRoutingPolicyOf = (
  settings: Pick<ServerSettings, "permissionRouting">,
): PermissionRoutingPolicy => settings.permissionRouting ?? DEFAULT_PERMISSION_ROUTING_POLICY;

export const resolveNobodyPermit = (input: {
  readonly request: OrchestrationV2RuntimeRequest;
  readonly sessions: ReadonlyArray<PermissionRoutingSessionSnapshot> | null;
}): PermissionRequestResolvedBy | null => {
  if (input.request.status !== "pending") return null;
  if (!isPermissionApprovalKind(input.request.kind)) return null;
  const routing: PermissionRequestRouting | undefined = input.request.routing;
  if (routing === undefined) return null;
  // Unknown session state must not auto-permit.
  if (input.sessions === null) return null;
  if (!shouldPermitWhenNobody(routing, input.sessions)) return null;
  return nobodyPermitResolvedBy(routing);
};

export const readPermissionRoutingPolicy = Effect.fn("PermissionRouting.readPolicy")(function* () {
  const settings = yield* Effect.serviceOption(ServerSettingsService.ServerSettingsService);
  if (Option.isNone(settings)) return DEFAULT_PERMISSION_ROUTING_POLICY;
  return yield* settings.value.getSettings.pipe(
    Effect.map(permissionRoutingPolicyOf),
    Effect.orElseSucceed(() => DEFAULT_PERMISSION_ROUTING_POLICY),
  );
});
