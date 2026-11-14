import * as qbusiness from "@distilled.cloud/aws/qbusiness";
import * as Layer from "effect/Layer";
import { makeQBusinessApplicationHttpBinding } from "./BindingHttp.ts";
import { DeleteAttachment } from "./DeleteAttachment.ts";

export const DeleteAttachmentHttp = Layer.effect(
  DeleteAttachment,
  makeQBusinessApplicationHttpBinding({
    tag: "AWS.QBusiness.DeleteAttachment",
    operation: qbusiness.deleteAttachment,
    actions: ["qbusiness:DeleteAttachment"],
  }),
);
