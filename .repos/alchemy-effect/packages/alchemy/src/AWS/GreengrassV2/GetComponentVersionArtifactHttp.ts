import * as greengrassv2 from "@distilled.cloud/aws/greengrassv2";
import * as Layer from "effect/Layer";
import { makeGreengrassComponentHttpBinding } from "./BindingHttp.ts";
import { GetComponentVersionArtifact } from "./GetComponentVersionArtifact.ts";

export const GetComponentVersionArtifactHttp = Layer.effect(
  GetComponentVersionArtifact,
  makeGreengrassComponentHttpBinding({
    tag: "AWS.GreengrassV2.GetComponentVersionArtifact",
    operation: greengrassv2.getComponentVersionArtifact,
    actions: ["greengrass:GetComponentVersionArtifact"],
  }),
);
