import * as repostspace from "@distilled.cloud/aws/repostspace";
import * as Layer from "effect/Layer";
import { makeRePostSpaceHttpBinding } from "./BindingHttp.ts";
import { UpdateChannel } from "./UpdateChannel.ts";

export const UpdateChannelHttp = Layer.effect(
  UpdateChannel,
  makeRePostSpaceHttpBinding({
    tag: "AWS.RePostSpace.UpdateChannel",
    operation: repostspace.updateChannel,
    actions: ["repostspace:UpdateChannel"],
  }),
);
