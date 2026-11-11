import * as ssm from "@distilled.cloud/aws/ssm-contacts";
import * as Layer from "effect/Layer";
import { makeRotationHttpBinding } from "./BindingHttp.ts";
import { CreateRotationOverride } from "./CreateRotationOverride.ts";

export const CreateRotationOverrideHttp = Layer.effect(
  CreateRotationOverride,
  makeRotationHttpBinding({
    tag: "AWS.SSMContacts.CreateRotationOverride",
    operation: ssm.createRotationOverride,
    actions: ["ssm-contacts:CreateRotationOverride"],
  }),
);
