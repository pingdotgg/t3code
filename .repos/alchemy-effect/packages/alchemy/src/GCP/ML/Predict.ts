import type * as ml from "@distilled.cloud/gcp/ml_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { Model } from "./Model.ts";

export interface PredictRequest extends Omit<
  ml.PredictProjectsRequest,
  "name"
> {}

/**
 * Runtime binding for AI Platform (legacy ML Engine) `projects.predict`.
 *
 * Bind this operation to a {@link Model} in a Function/Action init
 * phase. Requests that omit a version use the model's default version.
 * Provide {@link PredictHttp}.
 *
 * ### Predicting
 * **Example:** Score instances
 * ```typescript
 * const predict = yield* GCP.ML.Predict(model);
 * const result = yield* predict({
 *   body: {
 *     httpBody: {
 *       contentType: "application/json",
 *       data: btoa(JSON.stringify({ instances: [{ f1: 1 }] })),
 *     },
 *   },
 * });
 * ```
 *
 * @binding
 * @category ML
 */
export interface Predict extends Binding.Service<
  Predict,
  "GCP.ML.Predict",
  (
    model: Model,
  ) => Effect.Effect<
    (
      request: PredictRequest,
    ) => Effect.Effect<
      ml.GoogleApi__HttpBody,
      ml.PredictProjectsError,
      RuntimeContext
    >
  >
> {}

export const Predict = Binding.Service<Predict>("GCP.ML.Predict");
