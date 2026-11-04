import * as qbusiness from "@distilled.cloud/aws/qbusiness";
import * as Layer from "effect/Layer";
import { makeQBusinessIndexHttpBinding } from "./BindingHttp.ts";
import { DeleteGroup } from "./DeleteGroup.ts";

export const DeleteGroupHttp = Layer.effect(
  DeleteGroup,
  makeQBusinessIndexHttpBinding({
    tag: "AWS.QBusiness.DeleteGroup",
    operation: qbusiness.deleteGroup,
    actions: ["qbusiness:DeleteGroup"],
    subResources: ["data-source/*"],
  }),
);
