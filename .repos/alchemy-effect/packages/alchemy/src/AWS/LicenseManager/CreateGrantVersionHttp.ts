import * as licensemanager from "@distilled.cloud/aws/license-manager";
import * as Layer from "effect/Layer";
import { makeLicenseManagerHttpBinding } from "./BindingHttp.ts";
import { CreateGrantVersion } from "./CreateGrantVersion.ts";

export const CreateGrantVersionHttp = Layer.effect(
  CreateGrantVersion,
  makeLicenseManagerHttpBinding({
    capability: "CreateGrantVersion",
    iamActions: ["license-manager:CreateGrantVersion"],
    operation: licensemanager.createGrantVersion,
  }),
);
