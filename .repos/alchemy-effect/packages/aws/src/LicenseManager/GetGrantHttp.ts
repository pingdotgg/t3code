import * as licensemanager from "@distilled.cloud/aws/license-manager";
import * as Layer from "effect/Layer";
import { makeLicenseManagerHttpBinding } from "./BindingHttp.ts";
import { GetGrant } from "./GetGrant.ts";

export const GetGrantHttp = Layer.effect(
  GetGrant,
  makeLicenseManagerHttpBinding({
    capability: "GetGrant",
    iamActions: ["license-manager:GetGrant"],
    operation: licensemanager.getGrant,
  }),
);
