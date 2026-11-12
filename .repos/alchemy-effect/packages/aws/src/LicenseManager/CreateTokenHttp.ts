import * as licensemanager from "@distilled.cloud/aws/license-manager";
import * as Layer from "effect/Layer";
import { makeLicenseManagerHttpBinding } from "./BindingHttp.ts";
import { CreateToken } from "./CreateToken.ts";

export const CreateTokenHttp = Layer.effect(
  CreateToken,
  makeLicenseManagerHttpBinding({
    capability: "CreateToken",
    iamActions: ["license-manager:CreateToken"],
    operation: licensemanager.createToken,
  }),
);
