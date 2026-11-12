import * as licensemanager from "@distilled.cloud/aws/license-manager";
import * as Layer from "effect/Layer";
import { makeLicenseManagerHttpBinding } from "./BindingHttp.ts";
import { CreateGrant } from "./CreateGrant.ts";

export const CreateGrantHttp = Layer.effect(
  CreateGrant,
  makeLicenseManagerHttpBinding({
    capability: "CreateGrant",
    iamActions: ["license-manager:CreateGrant"],
    operation: licensemanager.createGrant,
  }),
);
