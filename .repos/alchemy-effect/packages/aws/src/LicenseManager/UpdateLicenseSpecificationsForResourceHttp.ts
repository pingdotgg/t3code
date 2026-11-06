import * as licensemanager from "@distilled.cloud/aws/license-manager";
import * as Layer from "effect/Layer";
import { makeLicenseManagerHttpBinding } from "./BindingHttp.ts";
import { UpdateLicenseSpecificationsForResource } from "./UpdateLicenseSpecificationsForResource.ts";

export const UpdateLicenseSpecificationsForResourceHttp = Layer.effect(
  UpdateLicenseSpecificationsForResource,
  makeLicenseManagerHttpBinding({
    capability: "UpdateLicenseSpecificationsForResource",
    iamActions: ["license-manager:UpdateLicenseSpecificationsForResource"],
    operation: licensemanager.updateLicenseSpecificationsForResource,
  }),
);
