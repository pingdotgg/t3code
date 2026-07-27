import type * as fis from "@distilled.cloud/aws/fis";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { ExperimentTemplate } from "./ExperimentTemplate.ts";

/**
 * Runtime binding for `fis:GetExperimentTemplate`.
 *
 * Reads the bound {@link ExperimentTemplate}'s full definition — targets,
 * actions, stop conditions, log and report configuration — so a runtime
 * function can inspect the experiment it is about to start. The template id
 * is injected from the binding. Provide the implementation with
 * `Effect.provide(AWS.FIS.GetExperimentTemplateHttp)`.
 * @binding
 * @section Inspecting Templates
 * @example Read the Bound Template's Definition
 * ```typescript
 * // init — bind the operation to the experiment template
 * const getExperimentTemplate = yield* AWS.FIS.GetExperimentTemplate(template);
 *
 * // runtime
 * const { experimentTemplate } = yield* getExperimentTemplate();
 * console.log(Object.keys(experimentTemplate?.actions ?? {}));
 * ```
 */
export interface GetExperimentTemplate extends Binding.Service<
  GetExperimentTemplate,
  "AWS.FIS.GetExperimentTemplate",
  (
    template: ExperimentTemplate,
  ) => Effect.Effect<
    () => Effect.Effect<
      fis.GetExperimentTemplateResponse,
      fis.GetExperimentTemplateError
    >
  >
> {}
export const GetExperimentTemplate = Binding.Service<GetExperimentTemplate>(
  "AWS.FIS.GetExperimentTemplate",
);
