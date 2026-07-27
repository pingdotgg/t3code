import type * as macie2 from "@distilled.cloud/aws/macie2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `macie2:PutFindingsPublicationConfiguration`.
 *
 * Updates the configuration settings for publishing findings to Security Hub.
 * Account-level operation — invoked with the caller's request as-is.
 * Provide the implementation with
 * `Effect.provide(AWS.Macie2.PutFindingsPublicationConfigurationHttp)`.
 * @binding
 * @section Publishing Findings
 * @example Publish Policy Findings to Security Hub
 * ```typescript
 * // init — account-level binding, no resource argument
 * const putFindingsPublicationConfiguration = yield* AWS.Macie2.PutFindingsPublicationConfiguration();
 *
 * // runtime
 * yield* putFindingsPublicationConfiguration({
 *   securityHubConfiguration: {
 *     publishClassificationFindings: false,
 *     publishPolicyFindings: true,
 *   },
 * });
 * ```
 */
export interface PutFindingsPublicationConfiguration extends Binding.Service<
  PutFindingsPublicationConfiguration,
  "AWS.Macie2.PutFindingsPublicationConfiguration",
  () => Effect.Effect<
    (
      request?: macie2.PutFindingsPublicationConfigurationRequest,
    ) => Effect.Effect<
      macie2.PutFindingsPublicationConfigurationResponse,
      macie2.PutFindingsPublicationConfigurationError
    >
  >
> {}
export const PutFindingsPublicationConfiguration =
  Binding.Service<PutFindingsPublicationConfiguration>(
    "AWS.Macie2.PutFindingsPublicationConfiguration",
  );
