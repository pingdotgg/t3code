import * as signer from "@distilled.cloud/aws/signer";
import * as Layer from "effect/Layer";
import { makeSignerHttpBinding } from "./BindingHttp.ts";
import { RevokeSignature } from "./RevokeSignature.ts";

export const RevokeSignatureHttp = Layer.effect(
  RevokeSignature,
  makeSignerHttpBinding({
    tag: "AWS.Signer.RevokeSignature",
    operation: signer.revokeSignature,
    actions: ["signer:RevokeSignature"],
  }),
);
