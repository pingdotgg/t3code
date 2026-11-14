import * as translate from "@distilled.cloud/gcp/translate_v3";
import * as Layer from "effect/Layer";
import { makeAdaptiveMtDatasetHttpBinding } from "./BindingHttp.ts";
import { GetAdaptiveMtDataset } from "./GetAdaptiveMtDataset.ts";

/**
 * HTTP implementation of {@link GetAdaptiveMtDataset}.
 *
 * @layer
 * @provides GCP.Translate.GetAdaptiveMtDataset
 */
export const GetAdaptiveMtDatasetHttp = Layer.effect(
  GetAdaptiveMtDataset,
  makeAdaptiveMtDatasetHttpBinding({
    tag: "GCP.Translate.GetAdaptiveMtDataset",
    operation: translate.getProjectsLocationsAdaptiveMtDatasets,
    iam: { role: "roles/cloudtranslate.viewer" },
  }),
);
