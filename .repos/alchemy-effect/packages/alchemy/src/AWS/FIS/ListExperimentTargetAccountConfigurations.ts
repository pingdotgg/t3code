import type * as fis from "@distilled.cloud/aws/fis";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `fis:ListExperimentTargetAccountConfigurations`.
 *
 * Lists the target account configurations a multi-account experiment
 * resolved — every account the experiment injects faults into. Provide the
 * implementation with
 * `Effect.provide(AWS.FIS.ListExperimentTargetAccountConfigurationsHttp)`.
 * @binding
 * @section Multi-Account Experiments
 * @example List an Experiment's Target Accounts
 * ```typescript
 * // init — account-level binding, no resource argument
 * const listTargetAccounts =
 *   yield* AWS.FIS.ListExperimentTargetAccountConfigurations();
 *
 * // runtime
 * const { targetAccountConfigurations } = yield* listTargetAccounts({
 *   experimentId,
 * });
 * console.log(
 *   (targetAccountConfigurations ?? []).map((c) => c.accountId),
 * );
 * ```
 */
export interface ListExperimentTargetAccountConfigurations extends Binding.Service<
  ListExperimentTargetAccountConfigurations,
  "AWS.FIS.ListExperimentTargetAccountConfigurations",
  () => Effect.Effect<
    (
      request: fis.ListExperimentTargetAccountConfigurationsRequest,
    ) => Effect.Effect<
      fis.ListExperimentTargetAccountConfigurationsResponse,
      fis.ListExperimentTargetAccountConfigurationsError
    >
  >
> {}
export const ListExperimentTargetAccountConfigurations =
  Binding.Service<ListExperimentTargetAccountConfigurations>(
    "AWS.FIS.ListExperimentTargetAccountConfigurations",
  );
