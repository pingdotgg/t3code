import type * as fis from "@distilled.cloud/aws/fis";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `fis:GetExperiment`.
 *
 * Reads a running or finished experiment — its state (`pending`,
 * `initiating`, `running`, `completed`, `stopped`, `failed`), per-action
 * progress, and log/report configuration. Experiments are created
 * dynamically, so this is an account-level binding addressed by experiment
 * id. Provide the implementation with
 * `Effect.provide(AWS.FIS.GetExperimentHttp)`.
 * @binding
 * @section Running Experiments
 * @example Poll an Experiment's State
 * ```typescript
 * // init — account-level binding, no resource argument
 * const getExperiment = yield* AWS.FIS.GetExperiment();
 *
 * // runtime
 * const { experiment } = yield* getExperiment({ id: experimentId });
 * console.log(experiment?.state?.status);
 * ```
 */
export interface GetExperiment extends Binding.Service<
  GetExperiment,
  "AWS.FIS.GetExperiment",
  () => Effect.Effect<
    (
      request: fis.GetExperimentRequest,
    ) => Effect.Effect<fis.GetExperimentResponse, fis.GetExperimentError>
  >
> {}
export const GetExperiment = Binding.Service<GetExperiment>(
  "AWS.FIS.GetExperiment",
);
