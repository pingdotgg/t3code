import * as qbusiness from "@distilled.cloud/aws/qbusiness";
import * as Layer from "effect/Layer";
import { makeQBusinessApplicationHttpBinding } from "./BindingHttp.ts";
import { ListMessages } from "./ListMessages.ts";

export const ListMessagesHttp = Layer.effect(
  ListMessages,
  makeQBusinessApplicationHttpBinding({
    tag: "AWS.QBusiness.ListMessages",
    operation: qbusiness.listMessages,
    actions: ["qbusiness:ListMessages"],
  }),
);
