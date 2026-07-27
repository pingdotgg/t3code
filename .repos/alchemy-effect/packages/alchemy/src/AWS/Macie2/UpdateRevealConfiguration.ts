import type * as macie2 from "@distilled.cloud/aws/macie2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `macie2:UpdateRevealConfiguration`.
 *
 * Updates the status and configuration settings for retrieving occurrences of sensitive data reported by findings.
 * Account-level operation — invoked with the caller's request as-is.
 * Provide the implementation with
 * `Effect.provide(AWS.Macie2.UpdateRevealConfigurationHttp)`.
 * @binding
 * @section Retrieving Sensitive Data Samples
 * @example Enable Sample Retrieval
 * ```typescript
 * // init — account-level binding, no resource argument
 * const updateRevealConfiguration = yield* AWS.Macie2.UpdateRevealConfiguration();
 *
 * // runtime
 * yield* updateRevealConfiguration({
 *   configuration: { status: "ENABLED" },
 * });
 * ```
 */
export interface UpdateRevealConfiguration extends Binding.Service<
  UpdateRevealConfiguration,
  "AWS.Macie2.UpdateRevealConfiguration",
  () => Effect.Effect<
    (
      request?: macie2.UpdateRevealConfigurationRequest,
    ) => Effect.Effect<
      macie2.UpdateRevealConfigurationResponse,
      macie2.UpdateRevealConfigurationError
    >
  >
> {}
export const UpdateRevealConfiguration =
  Binding.Service<UpdateRevealConfiguration>(
    "AWS.Macie2.UpdateRevealConfiguration",
  );
