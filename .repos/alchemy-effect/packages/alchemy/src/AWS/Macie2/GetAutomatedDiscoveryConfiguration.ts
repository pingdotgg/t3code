import type * as macie2 from "@distilled.cloud/aws/macie2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `macie2:GetAutomatedDiscoveryConfiguration`.
 *
 * Retrieves the configuration settings and status of automated sensitive data discovery for an organization or standalone account.
 * Account-level operation — invoked with the caller's request as-is.
 * Provide the implementation with
 * `Effect.provide(AWS.Macie2.GetAutomatedDiscoveryConfigurationHttp)`.
 * @binding
 * @section Automated Discovery
 * @example Read the Automated Discovery Configuration
 * ```typescript
 * // init — account-level binding, no resource argument
 * const getAutomatedDiscoveryConfiguration = yield* AWS.Macie2.GetAutomatedDiscoveryConfiguration();
 *
 * // runtime
 * const { status } = yield* getAutomatedDiscoveryConfiguration();
 * ```
 */
export interface GetAutomatedDiscoveryConfiguration extends Binding.Service<
  GetAutomatedDiscoveryConfiguration,
  "AWS.Macie2.GetAutomatedDiscoveryConfiguration",
  () => Effect.Effect<
    (
      request?: macie2.GetAutomatedDiscoveryConfigurationRequest,
    ) => Effect.Effect<
      macie2.GetAutomatedDiscoveryConfigurationResponse,
      macie2.GetAutomatedDiscoveryConfigurationError
    >
  >
> {}
export const GetAutomatedDiscoveryConfiguration =
  Binding.Service<GetAutomatedDiscoveryConfiguration>(
    "AWS.Macie2.GetAutomatedDiscoveryConfiguration",
  );
