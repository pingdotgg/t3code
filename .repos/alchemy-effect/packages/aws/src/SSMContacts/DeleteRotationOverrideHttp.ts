import * as ssm from "@distilled.cloud/aws/ssm-contacts";
import * as Layer from "effect/Layer";
import { makeRotationHttpBinding } from "./BindingHttp.ts";
import { DeleteRotationOverride } from "./DeleteRotationOverride.ts";

export const DeleteRotationOverrideHttp = Layer.effect(
  DeleteRotationOverride,
  makeRotationHttpBinding({
    tag: "AWS.SSMContacts.DeleteRotationOverride",
    operation: ssm.deleteRotationOverride,
    actions: ["ssm-contacts:DeleteRotationOverride"],
  }),
);
