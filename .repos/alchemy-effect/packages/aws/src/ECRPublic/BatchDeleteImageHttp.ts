import * as ecrpublic from "@distilled.cloud/aws/ecr-public";
import * as Layer from "effect/Layer";
import { BatchDeleteImage } from "./BatchDeleteImage.ts";
import { makePublicRepositoryHttpBinding } from "./BindingHttp.ts";

export const BatchDeleteImageHttp = Layer.effect(
  BatchDeleteImage,
  makePublicRepositoryHttpBinding({
    capability: "BatchDeleteImage",
    iamActions: ["ecr-public:BatchDeleteImage"],
    operation: ecrpublic.batchDeleteImage,
  }),
);
