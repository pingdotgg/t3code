import * as imagebuilder from "@distilled.cloud/aws/imagebuilder";
import * as Layer from "effect/Layer";
import { makeImageBuilderPipelineHttpBinding } from "./BindingHttp.ts";
import { ListImagePipelineImages } from "./ListImagePipelineImages.ts";

export const ListImagePipelineImagesHttp = Layer.effect(
  ListImagePipelineImages,
  makeImageBuilderPipelineHttpBinding({
    tag: "AWS.ImageBuilder.ListImagePipelineImages",
    operation: imagebuilder.listImagePipelineImages,
    actions: ["imagebuilder:ListImagePipelineImages"],
  }),
);
