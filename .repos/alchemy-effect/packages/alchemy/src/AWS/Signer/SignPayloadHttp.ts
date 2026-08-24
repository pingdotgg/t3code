import * as signer from "@distilled.cloud/aws/signer";
import * as Layer from "effect/Layer";
import { makeSignerProfileHttpBinding } from "./BindingHttp.ts";
import { SignPayload } from "./SignPayload.ts";

export const SignPayloadHttp = Layer.effect(
  SignPayload,
  makeSignerProfileHttpBinding({
    tag: "AWS.Signer.SignPayload",
    operation: signer.signPayload,
    actions: ["signer:SignPayload"],
  }),
);
