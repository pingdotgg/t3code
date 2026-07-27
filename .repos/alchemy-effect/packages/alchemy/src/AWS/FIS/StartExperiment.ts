import type * as fis from "@distilled.cloud/aws/fis";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { ExperimentTemplate } from "./ExperimentTemplate.ts";

/**
 * Runtime binding for `fis:StartExperiment`.
 *
 * Starts a fault-injection experiment from the bound
 * {@link ExperimentTemplate} — the template's id is injected and the
 * idempotency `clientToken` is generated automatically. The IAM grant covers
 * both the template and the `experiment/*` ARN the started experiment is
 * created under. Provide the implementation with
 * `Effect.provide(AWS.FIS.StartExperimentHttp)`.
 * @binding
 * @section Running Experiments
 * @example Start an Experiment from the Bound Template
 * ```typescript
 * // init — bind the operation to the experiment template
 * const startExperiment = yield* AWS.FIS.StartExperiment(template);
 *
 * // runtime
 * const { experiment } = yield* startExperiment();
 * console.log(experiment?.id, experiment?.state?.status);
 * ```
 */
export interface StartExperiment extends Binding.Service<
  StartExperiment,
  "AWS.FIS.StartExperiment",
  (
    template: ExperimentTemplate,
  ) => Effect.Effect<
    (
      request?: Omit<
        fis.StartExperimentRequest,
        "experimentTemplateId" | "clientToken"
      >,
    ) => Effect.Effect<fis.StartExperimentResponse, fis.StartExperimentError>
  >
> {}
export const StartExperiment = Binding.Service<StartExperiment>(
  "AWS.FIS.StartExperiment",
);
