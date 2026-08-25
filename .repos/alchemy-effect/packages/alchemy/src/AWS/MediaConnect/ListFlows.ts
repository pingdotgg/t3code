import type * as mediaconnect from "@distilled.cloud/aws/mediaconnect";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `mediaconnect:ListFlows`.
 *
 * Enumerates the account's MediaConnect flows (one page per call — pass
 * `NextToken` from the previous response to continue). Account-level: the
 * deploy-time grant is `mediaconnect:ListFlows` on `*`. Provide the
 * implementation with `Effect.provide(AWS.MediaConnect.ListFlowsHttp)`.
 * @binding
 * @section Observing Flows
 * @example Enumerate the Account's Flows
 * ```typescript
 * // init — bind the account-level operation
 * const listFlows = yield* AWS.MediaConnect.ListFlows();
 *
 * // runtime
 * const { Flows } = yield* listFlows({ MaxResults: 20 });
 * const active = (Flows ?? []).filter((f) => f.Status === "ACTIVE");
 * ```
 */
export interface ListFlows extends Binding.Service<
  ListFlows,
  "AWS.MediaConnect.ListFlows",
  () => Effect.Effect<
    (
      request?: mediaconnect.ListFlowsRequest,
    ) => Effect.Effect<
      mediaconnect.ListFlowsResponse,
      mediaconnect.ListFlowsError
    >
  >
> {}
export const ListFlows = Binding.Service<ListFlows>(
  "AWS.MediaConnect.ListFlows",
);
