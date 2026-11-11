import * as licensemanager from "@distilled.cloud/aws/license-manager";
import * as Layer from "effect/Layer";
import { makeLicenseManagerHttpBinding } from "./BindingHttp.ts";
import { GetAccessToken } from "./GetAccessToken.ts";

export const GetAccessTokenHttp = Layer.effect(
  GetAccessToken,
  makeLicenseManagerHttpBinding({
    capability: "GetAccessToken",
    iamActions: ["license-manager:GetAccessToken"],
    operation: licensemanager.getAccessToken,
  }),
);
