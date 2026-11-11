import * as licensemanager from "@distilled.cloud/aws/license-manager";
import * as Layer from "effect/Layer";
import { makeLicenseManagerHttpBinding } from "./BindingHttp.ts";
import { CheckoutLicense } from "./CheckoutLicense.ts";

export const CheckoutLicenseHttp = Layer.effect(
  CheckoutLicense,
  makeLicenseManagerHttpBinding({
    capability: "CheckoutLicense",
    iamActions: ["license-manager:CheckoutLicense"],
    operation: licensemanager.checkoutLicense,
  }),
);
