import * as licensemanager from "@distilled.cloud/aws/license-manager";
import * as Layer from "effect/Layer";
import { makeLicenseConfigurationHttpBinding } from "./BindingHttp.ts";
import { GetLicenseConfiguration } from "./GetLicenseConfiguration.ts";

export const GetLicenseConfigurationHttp = Layer.effect(
  GetLicenseConfiguration,
  makeLicenseConfigurationHttpBinding({
    capability: "GetLicenseConfiguration",
    iamActions: ["license-manager:GetLicenseConfiguration"],
    operation: licensemanager.getLicenseConfiguration,
  }),
);
