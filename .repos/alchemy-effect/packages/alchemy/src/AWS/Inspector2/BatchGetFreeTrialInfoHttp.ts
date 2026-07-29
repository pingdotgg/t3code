import * as inspector2 from "@distilled.cloud/aws/inspector2";
import * as Layer from "effect/Layer";
import { makeInspector2AccountHttpBinding } from "./BindingHttp.ts";
import { BatchGetFreeTrialInfo } from "./BatchGetFreeTrialInfo.ts";

export const BatchGetFreeTrialInfoHttp = Layer.effect(
  BatchGetFreeTrialInfo,
  makeInspector2AccountHttpBinding({
    tag: "AWS.Inspector2.BatchGetFreeTrialInfo",
    operation: inspector2.batchGetFreeTrialInfo,
    actions: ["inspector2:BatchGetFreeTrialInfo"],
  }),
);
