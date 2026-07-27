import type * as macie2 from "@distilled.cloud/aws/macie2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `macie2:GetFindingsPublicationConfiguration`.
 *
 * Retrieves the configuration settings for publishing findings to Security Hub.
 * Account-level operation — invoked with the caller's request as-is.
 * Provide the implementation with
 * `Effect.provide(AWS.Macie2.GetFindingsPublicationConfigurationHttp)`.
 * @binding
 * @section Publishing Findings
 * @example Read the Publication Configuration
 * ```typescript
 * // init — account-level binding, no resource argument
 * const getFindingsPublicationConfiguration = yield* AWS.Macie2.GetFindingsPublicationConfiguration();
 *
 * // runtime
 * const { securityHubConfiguration } = yield* getFindingsPublicationConfiguration();
 * ```
 */
export interface GetFindingsPublicationConfiguration extends Binding.Service<
  GetFindingsPublicationConfiguration,
  "AWS.Macie2.GetFindingsPublicationConfiguration",
  () => Effect.Effect<
    (
      request?: macie2.GetFindingsPublicationConfigurationRequest,
    ) => Effect.Effect<
      macie2.GetFindingsPublicationConfigurationResponse,
      macie2.GetFindingsPublicationConfigurationError
    >
  >
> {}
export const GetFindingsPublicationConfiguration =
  Binding.Service<GetFindingsPublicationConfiguration>(
    "AWS.Macie2.GetFindingsPublicationConfiguration",
  );
