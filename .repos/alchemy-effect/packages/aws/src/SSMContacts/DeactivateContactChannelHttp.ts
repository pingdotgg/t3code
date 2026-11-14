import * as ssm from "@distilled.cloud/aws/ssm-contacts";
import * as Layer from "effect/Layer";
import { makeContactChannelHttpBinding } from "./BindingHttp.ts";
import { DeactivateContactChannel } from "./DeactivateContactChannel.ts";

export const DeactivateContactChannelHttp = Layer.effect(
  DeactivateContactChannel,
  makeContactChannelHttpBinding({
    tag: "AWS.SSMContacts.DeactivateContactChannel",
    operation: ssm.deactivateContactChannel,
    actions: ["ssm-contacts:DeactivateContactChannel"],
  }),
);
