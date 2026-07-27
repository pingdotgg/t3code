import type * as route53 from "@distilled.cloud/aws/route-53";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { HealthCheck } from "./HealthCheck.ts";

/**
 * Runtime binding for the `GetHealthCheckLastFailureReason` operation (IAM
 * action `route53:GetHealthCheckLastFailureReason` on the health check ARN).
 *
 * Reads the reason each Route 53 checker last reported the bound
 * {@link HealthCheck} unhealthy — the diagnostic companion to
 * {@link GetHealthCheckStatus} for alerting and incident tooling. Endpoint
 * checks only (not `CALCULATED` / `RECOVERY_CONTROL`). Provide the
 * implementation with
 * `Effect.provide(AWS.Route53.GetHealthCheckLastFailureReasonHttp)`.
 * @binding
 * @section Observing Health Checks
 * @example Read the last failure reasons
 * ```typescript
 * const getLastFailureReason =
 *   yield* AWS.Route53.GetHealthCheckLastFailureReason(check);
 *
 * const { HealthCheckObservations } = yield* getLastFailureReason();
 * ```
 */
export interface GetHealthCheckLastFailureReason extends Binding.Service<
  GetHealthCheckLastFailureReason,
  "AWS.Route53.GetHealthCheckLastFailureReason",
  (
    healthCheck: HealthCheck,
  ) => Effect.Effect<
    () => Effect.Effect<
      route53.GetHealthCheckLastFailureReasonResponse,
      route53.GetHealthCheckLastFailureReasonError
    >
  >
> {}
export const GetHealthCheckLastFailureReason =
  Binding.Service<GetHealthCheckLastFailureReason>(
    "AWS.Route53.GetHealthCheckLastFailureReason",
  );
