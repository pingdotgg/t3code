import type * as macie2 from "@distilled.cloud/aws/macie2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `macie2:UpdateAutomatedDiscoveryConfiguration`.
 *
 * Changes the configuration settings and status of automated sensitive data discovery for an organization or standalone account.
 * Account-level operation — invoked with the caller's request as-is.
 * Provide the implementation with
 * `Effect.provide(AWS.Macie2.UpdateAutomatedDiscoveryConfigurationHttp)`.
 * @binding
 * @section Automated Discovery
 * @example Enable Automated Discovery
 * ```typescript
 * // init — account-level binding, no resource argument
 * const updateAutomatedDiscoveryConfiguration = yield* AWS.Macie2.UpdateAutomatedDiscoveryConfiguration();
 *
 * // runtime
 * yield* updateAutomatedDiscoveryConfiguration({ status: "ENABLED" });
 * ```
 */
export interface UpdateAutomatedDiscoveryConfiguration extends Binding.Service<
  UpdateAutomatedDiscoveryConfiguration,
  "AWS.Macie2.UpdateAutomatedDiscoveryConfiguration",
  () => Effect.Effect<
    (
      request?: macie2.UpdateAutomatedDiscoveryConfigurationRequest,
    ) => Effect.Effect<
      macie2.UpdateAutomatedDiscoveryConfigurationResponse,
      macie2.UpdateAutomatedDiscoveryConfigurationError
    >
  >
> {}
export const UpdateAutomatedDiscoveryConfiguration =
  Binding.Service<UpdateAutomatedDiscoveryConfiguration>(
    "AWS.Macie2.UpdateAutomatedDiscoveryConfiguration",
  );
