import * as kendra from "@distilled.cloud/aws/kendra";
import * as Layer from "effect/Layer";
import { makeKendraIndexHttpBinding } from "./BindingHttp.ts";
import { SubmitFeedback } from "./SubmitFeedback.ts";

export const SubmitFeedbackHttp = Layer.effect(
  SubmitFeedback,
  makeKendraIndexHttpBinding({
    tag: "AWS.Kendra.SubmitFeedback",
    operation: kendra.submitFeedback,
    actions: ["kendra:SubmitFeedback"],
  }),
);
