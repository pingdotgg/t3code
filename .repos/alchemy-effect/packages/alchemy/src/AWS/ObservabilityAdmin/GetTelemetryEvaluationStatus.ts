import type * as obs from "@distilled.cloud/aws/observabilityadmin";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `observabilityadmin:GetTelemetryEvaluationStatus` —
 * reads the account's telemetry config onboarding status (`RUNNING`,
 * `STOPPED`, `NOT_STARTED`, ...), e.g. for a compliance function that
 * verifies telemetry auditing stays enabled.
 *
 * Provide `AWS.ObservabilityAdmin.GetTelemetryEvaluationStatusHttp` on the
 * hosting Lambda Function to satisfy the requirement.
 * @binding
 * @section Reading Onboarding Status
 * @example Verify telemetry auditing is enabled
 * ```typescript
 * // init — grants observabilityadmin:GetTelemetryEvaluationStatus
 * const getEvaluationStatus = yield* AWS.ObservabilityAdmin.GetTelemetryEvaluationStatus();
 *
 * // runtime
 * const { Status } = yield* getEvaluationStatus();
 * if (Status !== "RUNNING") {
 *   yield* Effect.logWarning("telemetry auditing is off");
 * }
 * ```
 */
export interface GetTelemetryEvaluationStatus extends Binding.Service<
  GetTelemetryEvaluationStatus,
  "AWS.ObservabilityAdmin.GetTelemetryEvaluationStatus",
  () => Effect.Effect<
    (
      request?: obs.GetTelemetryEvaluationStatusRequest,
    ) => Effect.Effect<
      obs.GetTelemetryEvaluationStatusOutput,
      obs.GetTelemetryEvaluationStatusError
    >
  >
> {}

export const GetTelemetryEvaluationStatus =
  Binding.Service<GetTelemetryEvaluationStatus>(
    "AWS.ObservabilityAdmin.GetTelemetryEvaluationStatus",
  );
