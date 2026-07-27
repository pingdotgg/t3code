import * as inspector2 from "@distilled.cloud/aws/inspector2";
import * as Layer from "effect/Layer";
import { makeInspector2AccountHttpBinding } from "./BindingHttp.ts";
import { UpdateOrganizationConfiguration } from "./UpdateOrganizationConfiguration.ts";

export const UpdateOrganizationConfigurationHttp = Layer.effect(
  UpdateOrganizationConfiguration,
  makeInspector2AccountHttpBinding({
    tag: "AWS.Inspector2.UpdateOrganizationConfiguration",
    operation: inspector2.updateOrganizationConfiguration,
    actions: ["inspector2:UpdateOrganizationConfiguration"],
  }),
);
