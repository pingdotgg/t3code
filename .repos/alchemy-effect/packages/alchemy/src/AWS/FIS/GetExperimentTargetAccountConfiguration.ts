import type * as fis from "@distilled.cloud/aws/fis";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `fis:GetExperimentTargetAccountConfiguration`.
 *
 * Reads the target account configuration a multi-account experiment resolved
 * for a specific account — the role and description FIS uses to act in that
 * account. Provide the implementation with
 * `Effect.provide(AWS.FIS.GetExperimentTargetAccountConfigurationHttp)`.
 * @binding
 * @section Multi-Account Experiments
 * @example Read an Experiment's Target Account
 * ```typescript
 * // init — account-level binding, no resource argument
 * const getTargetAccount =
 *   yield* AWS.FIS.GetExperimentTargetAccountConfiguration();
 *
 * // runtime
 * const { targetAccountConfiguration } = yield* getTargetAccount({
 *   experimentId,
 *   accountId,
 * });
 * console.log(targetAccountConfiguration?.roleArn);
 * ```
 */
export interface GetExperimentTargetAccountConfiguration extends Binding.Service<
  GetExperimentTargetAccountConfiguration,
  "AWS.FIS.GetExperimentTargetAccountConfiguration",
  () => Effect.Effect<
    (
      request: fis.GetExperimentTargetAccountConfigurationRequest,
    ) => Effect.Effect<
      fis.GetExperimentTargetAccountConfigurationResponse,
      fis.GetExperimentTargetAccountConfigurationError
    >
  >
> {}
export const GetExperimentTargetAccountConfiguration =
  Binding.Service<GetExperimentTargetAccountConfiguration>(
    "AWS.FIS.GetExperimentTargetAccountConfiguration",
  );
