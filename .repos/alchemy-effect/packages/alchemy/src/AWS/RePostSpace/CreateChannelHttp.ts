import * as repostspace from "@distilled.cloud/aws/repostspace";
import * as Layer from "effect/Layer";
import { makeRePostSpaceHttpBinding } from "./BindingHttp.ts";
import { CreateChannel } from "./CreateChannel.ts";

export const CreateChannelHttp = Layer.effect(
  CreateChannel,
  makeRePostSpaceHttpBinding({
    tag: "AWS.RePostSpace.CreateChannel",
    operation: repostspace.createChannel,
    actions: ["repostspace:CreateChannel"],
  }),
);
