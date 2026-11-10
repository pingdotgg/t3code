import * as qbusiness from "@distilled.cloud/aws/qbusiness";
import * as Layer from "effect/Layer";
import { makeQBusinessApplicationHttpBinding } from "./BindingHttp.ts";
import { DisassociatePermission } from "./DisassociatePermission.ts";

export const DisassociatePermissionHttp = Layer.effect(
  DisassociatePermission,
  makeQBusinessApplicationHttpBinding({
    tag: "AWS.QBusiness.DisassociatePermission",
    operation: qbusiness.disassociatePermission,
    actions: ["qbusiness:DisassociatePermission"],
  }),
);
