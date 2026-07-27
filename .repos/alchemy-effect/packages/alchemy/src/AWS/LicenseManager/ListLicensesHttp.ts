import * as licensemanager from "@distilled.cloud/aws/license-manager";
import * as Layer from "effect/Layer";
import { makeLicenseManagerHttpBinding } from "./BindingHttp.ts";
import { ListLicenses } from "./ListLicenses.ts";

export const ListLicensesHttp = Layer.effect(
  ListLicenses,
  makeLicenseManagerHttpBinding({
    capability: "ListLicenses",
    iamActions: ["license-manager:ListLicenses"],
    operation: licensemanager.listLicenses,
  }),
);
