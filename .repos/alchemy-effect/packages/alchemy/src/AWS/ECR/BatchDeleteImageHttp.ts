import * as ecr from "@distilled.cloud/aws/ecr";
import * as Layer from "effect/Layer";
import { makeEcrRepositoryHttpBinding } from "./BindingHttp.ts";
import { BatchDeleteImage } from "./BatchDeleteImage.ts";

/** HTTP implementation of {@link BatchDeleteImage} over the ECR API. */
export const BatchDeleteImageHttp = Layer.effect(
  BatchDeleteImage,
  makeEcrRepositoryHttpBinding({
    capability: "BatchDeleteImage",
    operation: ecr.batchDeleteImage,
    iamActions: ["ecr:BatchDeleteImage"],
  }),
);
