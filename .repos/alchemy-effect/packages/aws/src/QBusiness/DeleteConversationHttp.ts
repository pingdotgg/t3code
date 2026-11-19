import * as qbusiness from "@distilled.cloud/aws/qbusiness";
import * as Layer from "effect/Layer";
import { makeQBusinessApplicationHttpBinding } from "./BindingHttp.ts";
import { DeleteConversation } from "./DeleteConversation.ts";

export const DeleteConversationHttp = Layer.effect(
  DeleteConversation,
  makeQBusinessApplicationHttpBinding({
    tag: "AWS.QBusiness.DeleteConversation",
    operation: qbusiness.deleteConversation,
    actions: ["qbusiness:DeleteConversation"],
  }),
);
