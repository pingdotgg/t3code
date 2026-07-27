import type * as obs from "@distilled.cloud/aws/observabilityadmin";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `observabilityadmin:GetTelemetryEnrichmentStatus` —
 * reads the status of the account's telemetry enrichment feature (resource
 * tags added to telemetry). Fails with a typed
 * `ResourceNotFoundException` when the account has never onboarded to
 * enrichment.
 *
 * Provide `AWS.ObservabilityAdmin.GetTelemetryEnrichmentStatusHttp` on the
 * hosting Lambda Function to satisfy the requirement.
 * @binding
 * @section Reading Enrichment Status
 * @example Read the enrichment status, tolerating never-onboarded
 * ```typescript
 * // init — grants observabilityadmin:GetTelemetryEnrichmentStatus
 * const getEnrichmentStatus = yield* AWS.ObservabilityAdmin.GetTelemetryEnrichmentStatus();
 *
 * // runtime
 * const status = yield* getEnrichmentStatus().pipe(
 *   Effect.map((r) => r.Status ?? "Stopped"),
 *   Effect.catchTag("ResourceNotFoundException", () =>
 *     Effect.succeed("NotOnboarded"),
 *   ),
 * );
 * ```
 */
export interface GetTelemetryEnrichmentStatus extends Binding.Service<
  GetTelemetryEnrichmentStatus,
  "AWS.ObservabilityAdmin.GetTelemetryEnrichmentStatus",
  () => Effect.Effect<
    (
      request?: obs.GetTelemetryEnrichmentStatusRequest,
    ) => Effect.Effect<
      obs.GetTelemetryEnrichmentStatusOutput,
      obs.GetTelemetryEnrichmentStatusError
    >
  >
> {}

export const GetTelemetryEnrichmentStatus =
  Binding.Service<GetTelemetryEnrichmentStatus>(
    "AWS.ObservabilityAdmin.GetTelemetryEnrichmentStatus",
  );
