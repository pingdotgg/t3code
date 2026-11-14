import * as qbusiness from "@distilled.cloud/aws/qbusiness";
import * as Layer from "effect/Layer";
import { AssociatePermission } from "./AssociatePermission.ts";
import { makeQBusinessApplicationHttpBinding } from "./BindingHttp.ts";

export const AssociatePermissionHttp = Layer.effect(
  AssociatePermission,
  makeQBusinessApplicationHttpBinding({
    tag: "AWS.QBusiness.AssociatePermission",
    operation: qbusiness.associatePermission,
    actions: ["qbusiness:AssociatePermission"],
  }),
);
