import * as licensemanager from "@distilled.cloud/aws/license-manager";
import * as Layer from "effect/Layer";
import { makeLicenseManagerHttpBinding } from "./BindingHttp.ts";
import { ListReceivedLicenses } from "./ListReceivedLicenses.ts";

export const ListReceivedLicensesHttp = Layer.effect(
  ListReceivedLicenses,
  makeLicenseManagerHttpBinding({
    capability: "ListReceivedLicenses",
    iamActions: ["license-manager:ListReceivedLicenses"],
    operation: licensemanager.listReceivedLicenses,
  }),
);
