import * as qbusiness from "@distilled.cloud/aws/qbusiness";
import * as Layer from "effect/Layer";
import { makeQBusinessApplicationHttpBinding } from "./BindingHttp.ts";
import { UpdateUser } from "./UpdateUser.ts";

export const UpdateUserHttp = Layer.effect(
  UpdateUser,
  makeQBusinessApplicationHttpBinding({
    tag: "AWS.QBusiness.UpdateUser",
    operation: qbusiness.updateUser,
    actions: ["qbusiness:UpdateUser"],
  }),
);
