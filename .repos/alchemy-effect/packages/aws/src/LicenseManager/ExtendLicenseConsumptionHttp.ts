import * as licensemanager from "@distilled.cloud/aws/license-manager";
import * as Layer from "effect/Layer";
import { makeLicenseManagerHttpBinding } from "./BindingHttp.ts";
import { ExtendLicenseConsumption } from "./ExtendLicenseConsumption.ts";

export const ExtendLicenseConsumptionHttp = Layer.effect(
  ExtendLicenseConsumption,
  makeLicenseManagerHttpBinding({
    capability: "ExtendLicenseConsumption",
    iamActions: ["license-manager:ExtendLicenseConsumption"],
    operation: licensemanager.extendLicenseConsumption,
  }),
);
