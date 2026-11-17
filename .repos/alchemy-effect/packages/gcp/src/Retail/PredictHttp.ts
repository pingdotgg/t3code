import * as retail from "@distilled.cloud/gcp/retail_v2";
import * as Layer from "effect/Layer";
import { makeServingConfigHttpBinding } from "./BindingHttp.ts";
import { Predict } from "./Predict.ts";

/**
 * HTTP implementation of {@link Predict}.
 *
 * @layer
 * @provides GCP.Retail.Predict
 */
export const PredictHttp = Layer.effect(
  Predict,
  makeServingConfigHttpBinding({
    tag: "GCP.Retail.Predict",
    operation: retail.predictProjectsLocationsCatalogsServingConfigs,
    iam: { role: "roles/retail.viewer" },
  }),
);
