import * as securityhub from "@distilled.cloud/aws/securityhub";
import * as Layer from "effect/Layer";
import { makeSecurityHubHttpBinding } from "./BindingHttp.ts";
import { UpdateOrganizationConfiguration } from "./UpdateOrganizationConfiguration.ts";

export const UpdateOrganizationConfigurationHttp = Layer.effect(
  UpdateOrganizationConfiguration,
  makeSecurityHubHttpBinding({
    tag: "AWS.SecurityHub.UpdateOrganizationConfiguration",
    operation: securityhub.updateOrganizationConfiguration,
    actions: ["securityhub:UpdateOrganizationConfiguration"],
  }),
);
