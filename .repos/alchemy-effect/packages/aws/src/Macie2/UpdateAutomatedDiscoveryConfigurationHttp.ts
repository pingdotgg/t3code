import * as macie2 from "@distilled.cloud/aws/macie2";
import * as Layer from "effect/Layer";
import { makeMacie2HttpBinding } from "./BindingHttp.ts";
import { UpdateAutomatedDiscoveryConfiguration } from "./UpdateAutomatedDiscoveryConfiguration.ts";

export const UpdateAutomatedDiscoveryConfigurationHttp = Layer.effect(
  UpdateAutomatedDiscoveryConfiguration,
  makeMacie2HttpBinding({
    tag: "AWS.Macie2.UpdateAutomatedDiscoveryConfiguration",
    operation: macie2.updateAutomatedDiscoveryConfiguration,
    actions: ["macie2:UpdateAutomatedDiscoveryConfiguration"],
  }),
);
