import * as licensemanager from "@distilled.cloud/aws/license-manager";
import * as Layer from "effect/Layer";
import { makeLicenseManagerHttpBinding } from "./BindingHttp.ts";
import { ListTokens } from "./ListTokens.ts";

export const ListTokensHttp = Layer.effect(
  ListTokens,
  makeLicenseManagerHttpBinding({
    capability: "ListTokens",
    iamActions: ["license-manager:ListTokens"],
    operation: licensemanager.listTokens,
  }),
);
