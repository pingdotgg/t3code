import * as ecrpublic from "@distilled.cloud/aws/ecr-public";
import * as Layer from "effect/Layer";
import { makePublicRepositoryHttpBinding } from "./BindingHttp.ts";
import { InitiateLayerUpload } from "./InitiateLayerUpload.ts";

export const InitiateLayerUploadHttp = Layer.effect(
  InitiateLayerUpload,
  makePublicRepositoryHttpBinding({
    capability: "InitiateLayerUpload",
    iamActions: ["ecr-public:InitiateLayerUpload"],
    operation: ecrpublic.initiateLayerUpload,
  }),
);
