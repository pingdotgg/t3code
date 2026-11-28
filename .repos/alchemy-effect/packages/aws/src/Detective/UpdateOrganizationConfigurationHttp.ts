import * as detective from "@distilled.cloud/aws/detective";
import * as Layer from "effect/Layer";
import { makeDetectiveGraphHttpBinding } from "./BindingHttp.ts";
import { UpdateOrganizationConfiguration } from "./UpdateOrganizationConfiguration.ts";

export const UpdateOrganizationConfigurationHttp = Layer.effect(
  UpdateOrganizationConfiguration,
  makeDetectiveGraphHttpBinding({
    tag: "AWS.Detective.UpdateOrganizationConfiguration",
    operation: detective.updateOrganizationConfiguration,
    actions: ["detective:UpdateOrganizationConfiguration"],
  }),
);
