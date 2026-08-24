import type * as ag from "@distilled.cloud/aws/api-gateway";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { UsagePlan } from "./UsagePlan.ts";

export interface GetUsageRequest extends Omit<
  ag.GetUsageRequest,
  "usagePlanId"
> {}

/**
 * Runtime binding for reading usage data of a {@link UsagePlan}
 * (`apigateway:GET` on `/usageplans/{id}/usage`).
 *
 * Bind a usage plan inside a function runtime to meter per-key API
 * consumption — the primitive for building billing or quota dashboards.
 * Provide `ApiGateway.GetUsageHttp` on the Function effect to implement
 * the binding.
 *
 * @binding
 * @section Metering usage
 * @example Read this month's usage for a key
 * ```typescript
 * // init
 * const getUsage = yield* ApiGateway.GetUsage(plan);
 *
 * // runtime
 * const usage = yield* getUsage({
 *   keyId,
 *   startDate: "2026-07-01",
 *   endDate: "2026-07-14",
 * });
 * ```
 */
export interface GetUsage extends Binding.Service<
  GetUsage,
  "AWS.ApiGateway.GetUsage",
  <P extends UsagePlan>(
    usagePlan: P,
  ) => Effect.Effect<
    (request: GetUsageRequest) => Effect.Effect<ag.Usage, ag.GetUsageError>
  >
> {}
export const GetUsage = Binding.Service<GetUsage>("AWS.ApiGateway.GetUsage");
