import * as inspector2 from "@distilled.cloud/aws/inspector2";
import * as Layer from "effect/Layer";
import { makeInspector2AccountHttpBinding } from "./BindingHttp.ts";
import { GetEc2DeepInspectionConfiguration } from "./GetEc2DeepInspectionConfiguration.ts";

export const GetEc2DeepInspectionConfigurationHttp = Layer.effect(
  GetEc2DeepInspectionConfiguration,
  makeInspector2AccountHttpBinding({
    tag: "AWS.Inspector2.GetEc2DeepInspectionConfiguration",
    operation: inspector2.getEc2DeepInspectionConfiguration,
    actions: ["inspector2:GetEc2DeepInspectionConfiguration"],
  }),
);
