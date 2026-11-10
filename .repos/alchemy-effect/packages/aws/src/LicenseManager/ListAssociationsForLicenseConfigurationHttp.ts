import * as licensemanager from "@distilled.cloud/aws/license-manager";
import * as Layer from "effect/Layer";
import { makeLicenseConfigurationHttpBinding } from "./BindingHttp.ts";
import { ListAssociationsForLicenseConfiguration } from "./ListAssociationsForLicenseConfiguration.ts";

export const ListAssociationsForLicenseConfigurationHttp = Layer.effect(
  ListAssociationsForLicenseConfiguration,
  makeLicenseConfigurationHttpBinding({
    capability: "ListAssociationsForLicenseConfiguration",
    iamActions: ["license-manager:ListAssociationsForLicenseConfiguration"],
    operation: licensemanager.listAssociationsForLicenseConfiguration,
  }),
);
