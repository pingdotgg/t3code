import * as ecr from "@distilled.cloud/aws/ecr";
import * as Layer from "effect/Layer";
import { makeEcrRepositoryHttpBinding } from "./BindingHttp.ts";
import { InitiateLayerUpload } from "./InitiateLayerUpload.ts";

/** HTTP implementation of {@link InitiateLayerUpload} over the ECR API. */
export const InitiateLayerUploadHttp = Layer.effect(
  InitiateLayerUpload,
  makeEcrRepositoryHttpBinding({
    capability: "InitiateLayerUpload",
    operation: ecr.initiateLayerUpload,
    iamActions: ["ecr:InitiateLayerUpload"],
  }),
);
