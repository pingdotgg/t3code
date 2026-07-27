import * as qbusiness from "@distilled.cloud/aws/qbusiness";
import * as Layer from "effect/Layer";
import { makeQBusinessApplicationHttpBinding } from "./BindingHttp.ts";
import { CreateUser } from "./CreateUser.ts";

export const CreateUserHttp = Layer.effect(
  CreateUser,
  makeQBusinessApplicationHttpBinding({
    tag: "AWS.QBusiness.CreateUser",
    operation: qbusiness.createUser,
    actions: ["qbusiness:CreateUser"],
  }),
);
