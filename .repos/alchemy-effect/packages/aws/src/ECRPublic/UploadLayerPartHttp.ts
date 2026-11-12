import * as ecrpublic from "@distilled.cloud/aws/ecr-public";
import * as Layer from "effect/Layer";
import { makePublicRepositoryHttpBinding } from "./BindingHttp.ts";
import { UploadLayerPart } from "./UploadLayerPart.ts";

export const UploadLayerPartHttp = Layer.effect(
  UploadLayerPart,
  makePublicRepositoryHttpBinding({
    capability: "UploadLayerPart",
    iamActions: ["ecr-public:UploadLayerPart"],
    operation: ecrpublic.uploadLayerPart,
  }),
);
