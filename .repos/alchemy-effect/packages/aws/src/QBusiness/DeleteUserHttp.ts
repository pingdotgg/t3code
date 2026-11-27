import * as qbusiness from "@distilled.cloud/aws/qbusiness";
import * as Layer from "effect/Layer";
import { makeQBusinessApplicationHttpBinding } from "./BindingHttp.ts";
import { DeleteUser } from "./DeleteUser.ts";

export const DeleteUserHttp = Layer.effect(
  DeleteUser,
  makeQBusinessApplicationHttpBinding({
    tag: "AWS.QBusiness.DeleteUser",
    operation: qbusiness.deleteUser,
    actions: ["qbusiness:DeleteUser"],
  }),
);
