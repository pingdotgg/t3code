import * as qbusiness from "@distilled.cloud/aws/qbusiness";
import * as Layer from "effect/Layer";
import { makeQBusinessApplicationHttpBinding } from "./BindingHttp.ts";
import { GetPolicy } from "./GetPolicy.ts";

export const GetPolicyHttp = Layer.effect(
  GetPolicy,
  makeQBusinessApplicationHttpBinding({
    tag: "AWS.QBusiness.GetPolicy",
    operation: qbusiness.getPolicy,
    actions: ["qbusiness:GetPolicy"],
  }),
);
