import type * as fis from "@distilled.cloud/aws/fis";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `fis:StopExperiment`.
 *
 * Stops a running experiment — the manual abort switch for a
 * chaos-engineering run that a monitoring function decides has gone far
 * enough. Experiments are created dynamically, so this is an account-level
 * binding addressed by experiment id. Provide the implementation with
 * `Effect.provide(AWS.FIS.StopExperimentHttp)`.
 * @binding
 * @section Running Experiments
 * @example Abort a Running Experiment
 * ```typescript
 * // init — account-level binding, no resource argument
 * const stopExperiment = yield* AWS.FIS.StopExperiment();
 *
 * // runtime
 * const { experiment } = yield* stopExperiment({ id: experimentId });
 * console.log(experiment?.state?.status); // "stopping"
 * ```
 */
export interface StopExperiment extends Binding.Service<
  StopExperiment,
  "AWS.FIS.StopExperiment",
  () => Effect.Effect<
    (
      request: fis.StopExperimentRequest,
    ) => Effect.Effect<fis.StopExperimentResponse, fis.StopExperimentError>
  >
> {}
export const StopExperiment = Binding.Service<StopExperiment>(
  "AWS.FIS.StopExperiment",
);
