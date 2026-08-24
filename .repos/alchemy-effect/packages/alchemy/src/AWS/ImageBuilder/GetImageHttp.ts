import * as imagebuilder from "@distilled.cloud/aws/imagebuilder";
import * as Layer from "effect/Layer";
import { makeImageBuilderAccountHttpBinding } from "./BindingHttp.ts";
import { GetImage } from "./GetImage.ts";

export const GetImageHttp = Layer.effect(
  GetImage,
  makeImageBuilderAccountHttpBinding({
    tag: "AWS.ImageBuilder.GetImage",
    operation: imagebuilder.getImage,
    actions: ["imagebuilder:GetImage"],
  }),
);
