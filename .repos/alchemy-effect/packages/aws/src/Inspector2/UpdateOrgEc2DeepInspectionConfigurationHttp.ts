import * as inspector2 from "@distilled.cloud/aws/inspector2";
import * as Layer from "effect/Layer";
import { makeInspector2AccountHttpBinding } from "./BindingHttp.ts";
import { UpdateOrgEc2DeepInspectionConfiguration } from "./UpdateOrgEc2DeepInspectionConfiguration.ts";

export const UpdateOrgEc2DeepInspectionConfigurationHttp = Layer.effect(
  UpdateOrgEc2DeepInspectionConfiguration,
  makeInspector2AccountHttpBinding({
    tag: "AWS.Inspector2.UpdateOrgEc2DeepInspectionConfiguration",
    operation: inspector2.updateOrgEc2DeepInspectionConfiguration,
    actions: ["inspector2:UpdateOrgEc2DeepInspectionConfiguration"],
  }),
);
