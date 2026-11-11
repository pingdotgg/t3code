import * as imagebuilder from "@distilled.cloud/aws/imagebuilder";
import * as Layer from "effect/Layer";
import { makeImageBuilderAccountHttpBinding } from "./BindingHttp.ts";
import { ListImages } from "./ListImages.ts";

export const ListImagesHttp = Layer.effect(
  ListImages,
  makeImageBuilderAccountHttpBinding({
    tag: "AWS.ImageBuilder.ListImages",
    operation: imagebuilder.listImages,
    actions: ["imagebuilder:ListImages"],
  }),
);
