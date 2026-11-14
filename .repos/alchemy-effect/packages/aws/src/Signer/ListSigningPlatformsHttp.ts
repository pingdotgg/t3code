import * as signer from "@distilled.cloud/aws/signer";
import * as Layer from "effect/Layer";
import { makeSignerHttpBinding } from "./BindingHttp.ts";
import { ListSigningPlatforms } from "./ListSigningPlatforms.ts";

export const ListSigningPlatformsHttp = Layer.effect(
  ListSigningPlatforms,
  makeSignerHttpBinding({
    tag: "AWS.Signer.ListSigningPlatforms",
    operation: signer.listSigningPlatforms,
    actions: ["signer:ListSigningPlatforms"],
  }),
);
