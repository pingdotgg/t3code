import * as inspector2 from "@distilled.cloud/aws/inspector2";
import * as Layer from "effect/Layer";
import { makeInspector2AccountHttpBinding } from "./BindingHttp.ts";
import { BatchUpdateMemberEc2DeepInspectionStatus } from "./BatchUpdateMemberEc2DeepInspectionStatus.ts";

export const BatchUpdateMemberEc2DeepInspectionStatusHttp = Layer.effect(
  BatchUpdateMemberEc2DeepInspectionStatus,
  makeInspector2AccountHttpBinding({
    tag: "AWS.Inspector2.BatchUpdateMemberEc2DeepInspectionStatus",
    operation: inspector2.batchUpdateMemberEc2DeepInspectionStatus,
    actions: ["inspector2:BatchUpdateMemberEc2DeepInspectionStatus"],
  }),
);
