import type * as macie2 from "@distilled.cloud/aws/macie2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `macie2:GetRevealConfiguration`.
 *
 * Retrieves the status and configuration settings for retrieving occurrences of sensitive data reported by findings.
 * Account-level operation — invoked with the caller's request as-is.
 * Provide the implementation with
 * `Effect.provide(AWS.Macie2.GetRevealConfigurationHttp)`.
 * @binding
 * @section Retrieving Sensitive Data Samples
 * @example Read the Reveal Configuration
 * ```typescript
 * // init — account-level binding, no resource argument
 * const getRevealConfiguration = yield* AWS.Macie2.GetRevealConfiguration();
 *
 * // runtime
 * const { configuration } = yield* getRevealConfiguration();
 * ```
 */
export interface GetRevealConfiguration extends Binding.Service<
  GetRevealConfiguration,
  "AWS.Macie2.GetRevealConfiguration",
  () => Effect.Effect<
    (
      request?: macie2.GetRevealConfigurationRequest,
    ) => Effect.Effect<
      macie2.GetRevealConfigurationResponse,
      macie2.GetRevealConfigurationError
    >
  >
> {}
export const GetRevealConfiguration = Binding.Service<GetRevealConfiguration>(
  "AWS.Macie2.GetRevealConfiguration",
);
