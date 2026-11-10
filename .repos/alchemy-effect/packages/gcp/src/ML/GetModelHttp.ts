import * as ml from "@distilled.cloud/gcp/ml_v1";
import * as Layer from "effect/Layer";
import { makeModelHttpBinding } from "./BindingHttp.ts";
import { GetModel } from "./GetModel.ts";

/**
 * HTTP implementation of {@link GetModel}.
 *
 * @layer
 * @provides GCP.ML.GetModel
 */
export const GetModelHttp = Layer.effect(
  GetModel,
  makeModelHttpBinding({
    tag: "GCP.ML.GetModel",
    operation: ml.getProjectsModels,
    iam: { role: "roles/ml.modelUser", on: "ml.model" },
  }),
);
