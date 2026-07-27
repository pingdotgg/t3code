import * as ssm from "@distilled.cloud/aws/ssm-contacts";
import * as Layer from "effect/Layer";
import { makeContactChannelHttpBinding } from "./BindingHttp.ts";
import { ActivateContactChannel } from "./ActivateContactChannel.ts";

export const ActivateContactChannelHttp = Layer.effect(
  ActivateContactChannel,
  makeContactChannelHttpBinding({
    tag: "AWS.SSMContacts.ActivateContactChannel",
    operation: ssm.activateContactChannel,
    actions: ["ssm-contacts:ActivateContactChannel"],
  }),
);
