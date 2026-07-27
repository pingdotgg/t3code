import * as licensemanager from "@distilled.cloud/aws/license-manager";
import * as Layer from "effect/Layer";
import { makeLicenseConfigurationHttpBinding } from "./BindingHttp.ts";
import { ListFailuresForLicenseConfigurationOperations } from "./ListFailuresForLicenseConfigurationOperations.ts";

export const ListFailuresForLicenseConfigurationOperationsHttp = Layer.effect(
  ListFailuresForLicenseConfigurationOperations,
  makeLicenseConfigurationHttpBinding({
    capability: "ListFailuresForLicenseConfigurationOperations",
    iamActions: [
      "license-manager:ListFailuresForLicenseConfigurationOperations",
    ],
    operation: licensemanager.listFailuresForLicenseConfigurationOperations,
  }),
);
