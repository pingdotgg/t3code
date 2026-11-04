import * as licensemanager from "@distilled.cloud/aws/license-manager";
import * as Layer from "effect/Layer";
import { makeLicenseManagerHttpBinding } from "./BindingHttp.ts";
import { RejectGrant } from "./RejectGrant.ts";

export const RejectGrantHttp = Layer.effect(
  RejectGrant,
  makeLicenseManagerHttpBinding({
    capability: "RejectGrant",
    iamActions: ["license-manager:RejectGrant"],
    operation: licensemanager.rejectGrant,
  }),
);
