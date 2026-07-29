import * as imagebuilder from "@distilled.cloud/aws/imagebuilder";
import * as Layer from "effect/Layer";
import { makeImageBuilderAccountHttpBinding } from "./BindingHttp.ts";
import { ListImageBuildVersions } from "./ListImageBuildVersions.ts";

export const ListImageBuildVersionsHttp = Layer.effect(
  ListImageBuildVersions,
  makeImageBuilderAccountHttpBinding({
    tag: "AWS.ImageBuilder.ListImageBuildVersions",
    operation: imagebuilder.listImageBuildVersions,
    actions: ["imagebuilder:ListImageBuildVersions"],
  }),
);
