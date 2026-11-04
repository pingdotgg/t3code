import * as macie2 from "@distilled.cloud/aws/macie2";
import * as Layer from "effect/Layer";
import { makeMacie2HttpBinding } from "./BindingHttp.ts";
import { GetAutomatedDiscoveryConfiguration } from "./GetAutomatedDiscoveryConfiguration.ts";

export const GetAutomatedDiscoveryConfigurationHttp = Layer.effect(
  GetAutomatedDiscoveryConfiguration,
  makeMacie2HttpBinding({
    tag: "AWS.Macie2.GetAutomatedDiscoveryConfiguration",
    operation: macie2.getAutomatedDiscoveryConfiguration,
    actions: ["macie2:GetAutomatedDiscoveryConfiguration"],
  }),
);
