import type * as route53domains from "@distilled.cloud/aws/route-53-domains";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

export interface GetOperationDetailRequest
  extends route53domains.GetOperationDetailRequest {}

/**
 * Runtime binding for `route53domains:GetOperationDetail` — return the
 * current status of an asynchronous Route 53 Domains operation (a domain
 * registration, renewal, transfer, or nameserver update identified by the
 * `OperationId` those calls return).
 *
 * Route 53 Domains is a global registration API with no resource-level IAM:
 * the binding takes no arguments and grants the function
 * `route53domains:GetOperationDetail` on `*`. Calls are pinned to
 * `us-east-1`, the only region that serves the Route 53 Domains API,
 * regardless of where the function runs.
 *
 * Provide the implementation with
 * `Effect.provide(AWS.Route53Domains.GetOperationDetailHttp)`.
 *
 * @binding
 * @section Tracking Registration Operations
 * @example Poll a Registration Until It Completes
 * ```typescript
 * // init
 * const getOperationDetail = yield* AWS.Route53Domains.GetOperationDetail();
 *
 * // runtime
 * const detail = yield* getOperationDetail({ OperationId: operationId }).pipe(
 *   Effect.repeat({
 *     schedule: Schedule.spaced("10 seconds"),
 *     until: (d) => d.Status === "SUCCESSFUL" || d.Status === "ERROR",
 *     times: 8,
 *   }),
 * );
 * ```
 */
export interface GetOperationDetail extends Binding.Service<
  GetOperationDetail,
  "AWS.Route53Domains.GetOperationDetail",
  () => Effect.Effect<
    (
      request: GetOperationDetailRequest,
    ) => Effect.Effect<
      route53domains.GetOperationDetailResponse,
      route53domains.GetOperationDetailError
    >
  >
> {}
export const GetOperationDetail = Binding.Service<GetOperationDetail>(
  "AWS.Route53Domains.GetOperationDetail",
);
