import * as qbusiness from "@distilled.cloud/aws/qbusiness";
import * as Layer from "effect/Layer";
import { makeQBusinessApplicationHttpBinding } from "./BindingHttp.ts";
import { PutFeedback } from "./PutFeedback.ts";

export const PutFeedbackHttp = Layer.effect(
  PutFeedback,
  makeQBusinessApplicationHttpBinding({
    tag: "AWS.QBusiness.PutFeedback",
    operation: qbusiness.putFeedback,
    actions: ["qbusiness:PutFeedback"],
  }),
);
