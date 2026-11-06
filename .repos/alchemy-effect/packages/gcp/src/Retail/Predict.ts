import type * as retail from "@distilled.cloud/gcp/retail_v2";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { CatalogsServingConfig } from "./CatalogsServingConfig.ts";

export interface PredictRequest extends Omit<
  retail.PredictProjectsLocationsCatalogsServingConfigsRequest,
  "placement"
> {}

/**
 * Runtime binding for Retail `servingConfigs.predict`.
 *
 * Bind this operation to a {@link CatalogsServingConfig} in a Function
 * or Action init phase. Provide {@link PredictHttp}.
 *
 * ### Predicting Recommendations
 * **Example:** Predict with validate-only
 * ```typescript
 * const predict = yield* GCP.Retail.Predict(serving);
 * const page = yield* predict({
 *   body: {
 *     validateOnly: true,
 *     userEvent: {
 *       eventType: "detail-page-view",
 *       visitorId: "visitor-1",
 *     },
 *   },
 * });
 * ```
 *
 * @binding
 * @category Retail
 */
export interface Predict extends Binding.Service<
  Predict,
  "GCP.Retail.Predict",
  (
    servingConfig: CatalogsServingConfig,
  ) => Effect.Effect<
    (
      request: PredictRequest,
    ) => Effect.Effect<
      retail.GoogleCloudRetailV2PredictResponse,
      retail.PredictProjectsLocationsCatalogsServingConfigsError,
      RuntimeContext
    >
  >
> {}

export const Predict = Binding.Service<Predict>("GCP.Retail.Predict");
