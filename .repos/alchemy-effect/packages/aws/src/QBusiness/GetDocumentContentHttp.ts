import * as qbusiness from "@distilled.cloud/aws/qbusiness";
import * as Layer from "effect/Layer";
import { makeQBusinessIndexHttpBinding } from "./BindingHttp.ts";
import { GetDocumentContent } from "./GetDocumentContent.ts";

export const GetDocumentContentHttp = Layer.effect(
  GetDocumentContent,
  makeQBusinessIndexHttpBinding({
    tag: "AWS.QBusiness.GetDocumentContent",
    operation: qbusiness.getDocumentContent,
    actions: ["qbusiness:GetDocumentContent"],
  }),
);
