import * as licensemanager from "@distilled.cloud/aws/license-manager";
import * as Layer from "effect/Layer";
import { makeLicenseManagerHttpBinding } from "./BindingHttp.ts";
import { CheckoutBorrowLicense } from "./CheckoutBorrowLicense.ts";

export const CheckoutBorrowLicenseHttp = Layer.effect(
  CheckoutBorrowLicense,
  makeLicenseManagerHttpBinding({
    capability: "CheckoutBorrowLicense",
    iamActions: ["license-manager:CheckoutBorrowLicense"],
    operation: licensemanager.checkoutBorrowLicense,
  }),
);
