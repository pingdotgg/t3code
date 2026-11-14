import * as licensemanager from "@distilled.cloud/aws/license-manager";
import * as Layer from "effect/Layer";
import { makeLicenseManagerHttpBinding } from "./BindingHttp.ts";
import { GetServiceSettings } from "./GetServiceSettings.ts";

export const GetServiceSettingsHttp = Layer.effect(
  GetServiceSettings,
  makeLicenseManagerHttpBinding({
    capability: "GetServiceSettings",
    iamActions: ["license-manager:GetServiceSettings"],
    operation: licensemanager.getServiceSettings,
  }),
);
