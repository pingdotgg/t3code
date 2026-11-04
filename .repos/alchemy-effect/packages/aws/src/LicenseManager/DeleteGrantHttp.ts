import * as licensemanager from "@distilled.cloud/aws/license-manager";
import * as Layer from "effect/Layer";
import { makeLicenseManagerHttpBinding } from "./BindingHttp.ts";
import { DeleteGrant } from "./DeleteGrant.ts";

export const DeleteGrantHttp = Layer.effect(
  DeleteGrant,
  makeLicenseManagerHttpBinding({
    capability: "DeleteGrant",
    iamActions: ["license-manager:DeleteGrant"],
    operation: licensemanager.deleteGrant,
  }),
);
