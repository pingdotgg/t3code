import * as licensemanager from "@distilled.cloud/aws/license-manager";
import * as Layer from "effect/Layer";
import { makeLicenseManagerHttpBinding } from "./BindingHttp.ts";
import { ListLicenseVersions } from "./ListLicenseVersions.ts";

export const ListLicenseVersionsHttp = Layer.effect(
  ListLicenseVersions,
  makeLicenseManagerHttpBinding({
    capability: "ListLicenseVersions",
    iamActions: ["license-manager:ListLicenseVersions"],
    operation: licensemanager.listLicenseVersions,
  }),
);
