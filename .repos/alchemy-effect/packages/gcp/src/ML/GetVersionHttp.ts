import * as ml from "@distilled.cloud/gcp/ml_v1";
import * as Layer from "effect/Layer";
import { makeVersionHttpBinding } from "./BindingHttp.ts";
import { GetVersion } from "./GetVersion.ts";

/**
 * HTTP implementation of {@link GetVersion}.
 *
 * @layer
 * @provides GCP.ML.GetVersion
 */
export const GetVersionHttp = Layer.effect(
  GetVersion,
  makeVersionHttpBinding({
    tag: "GCP.ML.GetVersion",
    operation: ml.getProjectsModelsVersions,
    iam: { role: "roles/ml.modelUser", on: "ml.model" },
  }),
);
