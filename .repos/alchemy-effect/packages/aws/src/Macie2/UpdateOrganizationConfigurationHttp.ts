import * as macie2 from "@distilled.cloud/aws/macie2";
import * as Layer from "effect/Layer";
import { makeMacie2HttpBinding } from "./BindingHttp.ts";
import { UpdateOrganizationConfiguration } from "./UpdateOrganizationConfiguration.ts";

export const UpdateOrganizationConfigurationHttp = Layer.effect(
  UpdateOrganizationConfiguration,
  makeMacie2HttpBinding({
    tag: "AWS.Macie2.UpdateOrganizationConfiguration",
    operation: macie2.updateOrganizationConfiguration,
    actions: ["macie2:UpdateOrganizationConfiguration"],
  }),
);
