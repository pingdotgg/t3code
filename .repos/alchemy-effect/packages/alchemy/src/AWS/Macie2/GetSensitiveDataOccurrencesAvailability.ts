import type * as macie2 from "@distilled.cloud/aws/macie2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `macie2:GetSensitiveDataOccurrencesAvailability`.
 *
 * Checks whether occurrences of sensitive data can be retrieved for a finding.
 * Account-level operation — invoked with the caller's request as-is.
 * Provide the implementation with
 * `Effect.provide(AWS.Macie2.GetSensitiveDataOccurrencesAvailabilityHttp)`.
 * @binding
 * @section Retrieving Sensitive Data Samples
 * @example Check Sample Availability
 * ```typescript
 * // init — account-level binding, no resource argument
 * const getSensitiveDataOccurrencesAvailability = yield* AWS.Macie2.GetSensitiveDataOccurrencesAvailability();
 *
 * // runtime
 * const { code } = yield* getSensitiveDataOccurrencesAvailability({ findingId });
 * ```
 */
export interface GetSensitiveDataOccurrencesAvailability extends Binding.Service<
  GetSensitiveDataOccurrencesAvailability,
  "AWS.Macie2.GetSensitiveDataOccurrencesAvailability",
  () => Effect.Effect<
    (
      request: macie2.GetSensitiveDataOccurrencesAvailabilityRequest,
    ) => Effect.Effect<
      macie2.GetSensitiveDataOccurrencesAvailabilityResponse,
      macie2.GetSensitiveDataOccurrencesAvailabilityError
    >
  >
> {}
export const GetSensitiveDataOccurrencesAvailability =
  Binding.Service<GetSensitiveDataOccurrencesAvailability>(
    "AWS.Macie2.GetSensitiveDataOccurrencesAvailability",
  );
