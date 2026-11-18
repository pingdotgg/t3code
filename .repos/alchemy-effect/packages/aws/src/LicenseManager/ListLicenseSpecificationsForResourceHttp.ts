import * as licensemanager from "@distilled.cloud/aws/license-manager";
import * as Layer from "effect/Layer";
import { makeLicenseManagerHttpBinding } from "./BindingHttp.ts";
import { ListLicenseSpecificationsForResource } from "./ListLicenseSpecificationsForResource.ts";

export const ListLicenseSpecificationsForResourceHttp = Layer.effect(
  ListLicenseSpecificationsForResource,
  makeLicenseManagerHttpBinding({
    capability: "ListLicenseSpecificationsForResource",
    iamActions: ["license-manager:ListLicenseSpecificationsForResource"],
    operation: licensemanager.listLicenseSpecificationsForResource,
  }),
);
