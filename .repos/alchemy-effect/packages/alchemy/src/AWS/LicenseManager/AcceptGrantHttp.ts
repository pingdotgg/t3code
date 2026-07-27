import * as licensemanager from "@distilled.cloud/aws/license-manager";
import * as Layer from "effect/Layer";
import { makeLicenseManagerHttpBinding } from "./BindingHttp.ts";
import { AcceptGrant } from "./AcceptGrant.ts";

export const AcceptGrantHttp = Layer.effect(
  AcceptGrant,
  makeLicenseManagerHttpBinding({
    capability: "AcceptGrant",
    iamActions: ["license-manager:AcceptGrant"],
    operation: licensemanager.acceptGrant,
  }),
);
