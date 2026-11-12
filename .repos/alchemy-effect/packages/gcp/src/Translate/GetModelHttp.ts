import * as translate from "@distilled.cloud/gcp/translate_v3";
import * as Layer from "effect/Layer";
import { makeModelHttpBinding } from "./BindingHttp.ts";
import { GetModel } from "./GetModel.ts";

/**
 * HTTP implementation of {@link GetModel}.
 *
 * @layer
 * @provides GCP.Translate.GetModel
 */
export const GetModelHttp = Layer.effect(
  GetModel,
  makeModelHttpBinding({
    tag: "GCP.Translate.GetModel",
    operation: translate.getProjectsLocationsModels,
    iam: { role: "roles/cloudtranslate.viewer" },
  }),
);
