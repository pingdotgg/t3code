import type * as route53 from "@distilled.cloud/aws/route-53";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `GetChange` operation (IAM action
 * `route53:GetChange` on `arn:aws:route53:::change/*`).
 *
 * Polls the status of a record change submitted via
 * {@link ChangeResourceRecordSets} — `PENDING` until the change has
 * propagated to all authoritative name servers, then `INSYNC`. Pass the
 * bare change id (strip a leading `/change/` from `ChangeInfo.Id`).
 * Provide the implementation with
 * `Effect.provide(AWS.Route53.GetChangeHttp)`.
 * @binding
 * @section Managing Records at Runtime
 * @example Wait for a change to propagate
 * ```typescript
 * const getChange = yield* AWS.Route53.GetChange();
 *
 * const status = yield* getChange({
 *   Id: changeId.replace(/^\/change\//, ""),
 * }).pipe(
 *   Effect.map((r) => r.ChangeInfo.Status),
 *   Effect.repeat({
 *     schedule: Schedule.fixed("2 seconds"),
 *     until: (status) => status === "INSYNC",
 *     times: 30,
 *   }),
 * );
 * ```
 */
export interface GetChange extends Binding.Service<
  GetChange,
  "AWS.Route53.GetChange",
  () => Effect.Effect<
    (
      request: route53.GetChangeRequest,
    ) => Effect.Effect<route53.GetChangeResponse, route53.GetChangeError>
  >
> {}
export const GetChange = Binding.Service<GetChange>("AWS.Route53.GetChange");
