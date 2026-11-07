import * as ssm from "@distilled.cloud/aws/ssm-contacts";
import * as Layer from "effect/Layer";
import { makeRotationHttpBinding } from "./BindingHttp.ts";
import { GetRotationOverride } from "./GetRotationOverride.ts";

export const GetRotationOverrideHttp = Layer.effect(
  GetRotationOverride,
  makeRotationHttpBinding({
    tag: "AWS.SSMContacts.GetRotationOverride",
    operation: ssm.getRotationOverride,
    actions: ["ssm-contacts:GetRotationOverride"],
  }),
);
