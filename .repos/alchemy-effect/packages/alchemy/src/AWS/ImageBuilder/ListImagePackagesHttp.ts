import * as imagebuilder from "@distilled.cloud/aws/imagebuilder";
import * as Layer from "effect/Layer";
import { makeImageBuilderAccountHttpBinding } from "./BindingHttp.ts";
import { ListImagePackages } from "./ListImagePackages.ts";

export const ListImagePackagesHttp = Layer.effect(
  ListImagePackages,
  makeImageBuilderAccountHttpBinding({
    tag: "AWS.ImageBuilder.ListImagePackages",
    operation: imagebuilder.listImagePackages,
    actions: ["imagebuilder:ListImagePackages"],
  }),
);
