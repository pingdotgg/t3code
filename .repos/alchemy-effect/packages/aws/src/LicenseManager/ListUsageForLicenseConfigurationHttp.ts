import * as licensemanager from "@distilled.cloud/aws/license-manager";
import * as Layer from "effect/Layer";
import { makeLicenseConfigurationHttpBinding } from "./BindingHttp.ts";
import { ListUsageForLicenseConfiguration } from "./ListUsageForLicenseConfiguration.ts";

export const ListUsageForLicenseConfigurationHttp = Layer.effect(
  ListUsageForLicenseConfiguration,
  makeLicenseConfigurationHttpBinding({
    capability: "ListUsageForLicenseConfiguration",
    iamActions: ["license-manager:ListUsageForLicenseConfiguration"],
    operation: licensemanager.listUsageForLicenseConfiguration,
  }),
);
