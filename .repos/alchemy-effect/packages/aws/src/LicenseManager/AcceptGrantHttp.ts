import * as licensemanager from "@distilled.cloud/aws/license-manager";
import * as Layer from "effect/Layer";
import { AcceptGrant } from "./AcceptGrant.ts";
import { makeLicenseManagerHttpBinding } from "./BindingHttp.ts";

export const AcceptGrantHttp = Layer.effect(
  AcceptGrant,
  makeLicenseManagerHttpBinding({
    capability: "AcceptGrant",
    iamActions: ["license-manager:AcceptGrant"],
    operation: licensemanager.acceptGrant,
  }),
);
