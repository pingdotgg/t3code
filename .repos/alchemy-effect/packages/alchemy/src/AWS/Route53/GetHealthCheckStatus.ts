import type * as route53 from "@distilled.cloud/aws/route-53";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { HealthCheck } from "./HealthCheck.ts";

/**
 * Runtime binding for the `GetHealthCheckStatus` operation (IAM action
 * `route53:GetHealthCheckStatus` on the health check ARN).
 *
 * Reads the bound {@link HealthCheck}'s current status as reported by each
 * Route 53 checker — drive dashboards or failover decisions from the same
 * signal Route 53 routes on. Endpoint checks only (not `CALCULATED` /
 * `RECOVERY_CONTROL`). Provide the implementation with
 * `Effect.provide(AWS.Route53.GetHealthCheckStatusHttp)`.
 * @binding
 * @section Observing Health Checks
 * @example Read checker observations
 * ```typescript
 * const getHealthCheckStatus = yield* AWS.Route53.GetHealthCheckStatus(check);
 *
 * const { HealthCheckObservations } = yield* getHealthCheckStatus();
 * for (const observation of HealthCheckObservations) {
 *   yield* Effect.log(
 *     `${observation.Region}: ${observation.StatusReport?.Status}`,
 *   );
 * }
 * ```
 */
export interface GetHealthCheckStatus extends Binding.Service<
  GetHealthCheckStatus,
  "AWS.Route53.GetHealthCheckStatus",
  (
    healthCheck: HealthCheck,
  ) => Effect.Effect<
    () => Effect.Effect<
      route53.GetHealthCheckStatusResponse,
      route53.GetHealthCheckStatusError
    >
  >
> {}
export const GetHealthCheckStatus = Binding.Service<GetHealthCheckStatus>(
  "AWS.Route53.GetHealthCheckStatus",
);
