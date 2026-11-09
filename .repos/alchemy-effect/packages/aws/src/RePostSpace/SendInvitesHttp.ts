import * as repostspace from "@distilled.cloud/aws/repostspace";
import * as Layer from "effect/Layer";
import { makeRePostSpaceHttpBinding } from "./BindingHttp.ts";
import { SendInvites } from "./SendInvites.ts";

export const SendInvitesHttp = Layer.effect(
  SendInvites,
  makeRePostSpaceHttpBinding({
    tag: "AWS.RePostSpace.SendInvites",
    operation: repostspace.sendInvites,
    actions: ["repostspace:SendInvites"],
  }),
);
