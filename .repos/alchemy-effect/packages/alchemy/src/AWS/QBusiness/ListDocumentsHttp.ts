import * as qbusiness from "@distilled.cloud/aws/qbusiness";
import * as Layer from "effect/Layer";
import { makeQBusinessIndexHttpBinding } from "./BindingHttp.ts";
import { ListDocuments } from "./ListDocuments.ts";

export const ListDocumentsHttp = Layer.effect(
  ListDocuments,
  makeQBusinessIndexHttpBinding({
    tag: "AWS.QBusiness.ListDocuments",
    operation: qbusiness.listDocuments,
    actions: ["qbusiness:ListDocuments"],
  }),
);
