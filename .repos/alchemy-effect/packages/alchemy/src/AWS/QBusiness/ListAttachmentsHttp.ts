import * as qbusiness from "@distilled.cloud/aws/qbusiness";
import * as Layer from "effect/Layer";
import { makeQBusinessApplicationHttpBinding } from "./BindingHttp.ts";
import { ListAttachments } from "./ListAttachments.ts";

export const ListAttachmentsHttp = Layer.effect(
  ListAttachments,
  makeQBusinessApplicationHttpBinding({
    tag: "AWS.QBusiness.ListAttachments",
    operation: qbusiness.listAttachments,
    actions: ["qbusiness:ListAttachments"],
  }),
);
