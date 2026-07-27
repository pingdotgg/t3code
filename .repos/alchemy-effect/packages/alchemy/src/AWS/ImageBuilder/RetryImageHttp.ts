import * as imagebuilder from "@distilled.cloud/aws/imagebuilder";
import * as Layer from "effect/Layer";
import { makeImageBuilderAccountHttpBinding } from "./BindingHttp.ts";
import { RetryImage } from "./RetryImage.ts";

export const RetryImageHttp = Layer.effect(
  RetryImage,
  makeImageBuilderAccountHttpBinding({
    tag: "AWS.ImageBuilder.RetryImage",
    operation: imagebuilder.retryImage,
    actions: ["imagebuilder:RetryImage"],
  }),
);
