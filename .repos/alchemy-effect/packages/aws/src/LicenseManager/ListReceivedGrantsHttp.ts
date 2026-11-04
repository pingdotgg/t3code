import * as licensemanager from "@distilled.cloud/aws/license-manager";
import * as Layer from "effect/Layer";
import { makeLicenseManagerHttpBinding } from "./BindingHttp.ts";
import { ListReceivedGrants } from "./ListReceivedGrants.ts";

export const ListReceivedGrantsHttp = Layer.effect(
  ListReceivedGrants,
  makeLicenseManagerHttpBinding({
    capability: "ListReceivedGrants",
    iamActions: ["license-manager:ListReceivedGrants"],
    operation: licensemanager.listReceivedGrants,
  }),
);
