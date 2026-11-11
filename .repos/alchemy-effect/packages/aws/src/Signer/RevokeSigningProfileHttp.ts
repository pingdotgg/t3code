import * as signer from "@distilled.cloud/aws/signer";
import * as Layer from "effect/Layer";
import { makeSignerProfileHttpBinding } from "./BindingHttp.ts";
import { RevokeSigningProfile } from "./RevokeSigningProfile.ts";

export const RevokeSigningProfileHttp = Layer.effect(
  RevokeSigningProfile,
  makeSignerProfileHttpBinding({
    tag: "AWS.Signer.RevokeSigningProfile",
    operation: signer.revokeSigningProfile,
    actions: ["signer:RevokeSigningProfile"],
  }),
);
