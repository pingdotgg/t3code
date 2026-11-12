import * as imagebuilder from "@distilled.cloud/aws/imagebuilder";
import * as Layer from "effect/Layer";
import { makeImageBuilderPipelineHttpBinding } from "./BindingHttp.ts";
import { GetImagePipeline } from "./GetImagePipeline.ts";

export const GetImagePipelineHttp = Layer.effect(
  GetImagePipeline,
  makeImageBuilderPipelineHttpBinding({
    tag: "AWS.ImageBuilder.GetImagePipeline",
    operation: imagebuilder.getImagePipeline,
    actions: ["imagebuilder:GetImagePipeline"],
  }),
);
