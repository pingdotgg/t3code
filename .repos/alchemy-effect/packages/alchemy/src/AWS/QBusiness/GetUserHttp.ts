import * as qbusiness from "@distilled.cloud/aws/qbusiness";
import * as Layer from "effect/Layer";
import { makeQBusinessApplicationHttpBinding } from "./BindingHttp.ts";
import { GetUser } from "./GetUser.ts";

export const GetUserHttp = Layer.effect(
  GetUser,
  makeQBusinessApplicationHttpBinding({
    tag: "AWS.QBusiness.GetUser",
    operation: qbusiness.getUser,
    actions: ["qbusiness:GetUser"],
  }),
);
