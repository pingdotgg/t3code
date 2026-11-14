import * as licensemanager from "@distilled.cloud/aws/license-manager";
import * as Layer from "effect/Layer";
import { makeLicenseManagerHttpBinding } from "./BindingHttp.ts";
import { DeleteToken } from "./DeleteToken.ts";

export const DeleteTokenHttp = Layer.effect(
  DeleteToken,
  makeLicenseManagerHttpBinding({
    capability: "DeleteToken",
    iamActions: ["license-manager:DeleteToken"],
    operation: licensemanager.deleteToken,
  }),
);
