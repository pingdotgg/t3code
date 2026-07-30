import * as macie2 from "@distilled.cloud/aws/macie2";
import * as Layer from "effect/Layer";
import { makeMacie2HttpBinding } from "./BindingHttp.ts";
import { GetRevealConfiguration } from "./GetRevealConfiguration.ts";

export const GetRevealConfigurationHttp = Layer.effect(
  GetRevealConfiguration,
  makeMacie2HttpBinding({
    tag: "AWS.Macie2.GetRevealConfiguration",
    operation: macie2.getRevealConfiguration,
    actions: ["macie2:GetRevealConfiguration"],
  }),
);
