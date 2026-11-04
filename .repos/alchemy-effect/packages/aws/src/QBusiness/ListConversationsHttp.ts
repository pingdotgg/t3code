import * as qbusiness from "@distilled.cloud/aws/qbusiness";
import * as Layer from "effect/Layer";
import { makeQBusinessApplicationHttpBinding } from "./BindingHttp.ts";
import { ListConversations } from "./ListConversations.ts";

export const ListConversationsHttp = Layer.effect(
  ListConversations,
  makeQBusinessApplicationHttpBinding({
    tag: "AWS.QBusiness.ListConversations",
    operation: qbusiness.listConversations,
    actions: ["qbusiness:ListConversations"],
  }),
);
