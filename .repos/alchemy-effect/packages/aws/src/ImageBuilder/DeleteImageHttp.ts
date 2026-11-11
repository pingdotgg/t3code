import * as imagebuilder from "@distilled.cloud/aws/imagebuilder";
import * as Layer from "effect/Layer";
import { makeImageBuilderAccountHttpBinding } from "./BindingHttp.ts";
import { DeleteImage } from "./DeleteImage.ts";

export const DeleteImageHttp = Layer.effect(
  DeleteImage,
  makeImageBuilderAccountHttpBinding({
    tag: "AWS.ImageBuilder.DeleteImage",
    operation: imagebuilder.deleteImage,
    actions: ["imagebuilder:DeleteImage"],
  }),
);
