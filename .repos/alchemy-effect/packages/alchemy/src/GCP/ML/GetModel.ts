import type * as ml from "@distilled.cloud/gcp/ml_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { Model } from "./Model.ts";

export interface GetModelRequest extends Omit<
  ml.GetProjectsModelsRequest,
  "name"
> {}

/**
 * Runtime binding for AI Platform (legacy ML Engine) `models.get`.
 *
 * Bind this operation to a {@link Model} in a Function/Action init
 * phase. Provide {@link GetModelHttp}.
 *
 * ### Reading a Model
 * **Example:** Get the bound model
 * ```typescript
 * const getModel = yield* GCP.ML.GetModel(model);
 * const live = yield* getModel();
 * ```
 *
 * @binding
 * @category ML
 */
export interface GetModel extends Binding.Service<
  GetModel,
  "GCP.ML.GetModel",
  (
    model: Model,
  ) => Effect.Effect<
    (
      request?: GetModelRequest,
    ) => Effect.Effect<
      ml.GoogleCloudMlV1__Model,
      ml.GetProjectsModelsError,
      RuntimeContext
    >
  >
> {}

export const GetModel = Binding.Service<GetModel>("GCP.ML.GetModel");
