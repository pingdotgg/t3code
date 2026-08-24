import * as licensemanager from "@distilled.cloud/aws/license-manager";
import * as Layer from "effect/Layer";
import { makeLicenseManagerHttpBinding } from "./BindingHttp.ts";
import { GetLicense } from "./GetLicense.ts";

export const GetLicenseHttp = Layer.effect(
  GetLicense,
  makeLicenseManagerHttpBinding({
    capability: "GetLicense",
    iamActions: ["license-manager:GetLicense"],
    operation: licensemanager.getLicense,
  }),
);
