import * as ml from "@distilled.cloud/gcp/ml_v1";
import * as Layer from "effect/Layer";
import { makeModelHttpBinding } from "./BindingHttp.ts";
import { Predict } from "./Predict.ts";

/**
 * HTTP implementation of {@link Predict}.
 *
 * @layer
 * @provides GCP.ML.Predict
 */
export const PredictHttp = Layer.effect(
  Predict,
  makeModelHttpBinding({
    tag: "GCP.ML.Predict",
    operation: ml.predictProjects,
    iam: { role: "roles/ml.modelUser", on: "ml.model" },
  }),
);
