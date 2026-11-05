import * as licensemanager from "@distilled.cloud/aws/license-manager";
import * as Layer from "effect/Layer";
import { makeLicenseManagerHttpBinding } from "./BindingHttp.ts";
import { GetLicenseUsage } from "./GetLicenseUsage.ts";

export const GetLicenseUsageHttp = Layer.effect(
  GetLicenseUsage,
  makeLicenseManagerHttpBinding({
    capability: "GetLicenseUsage",
    iamActions: ["license-manager:GetLicenseUsage"],
    operation: licensemanager.getLicenseUsage,
  }),
);
