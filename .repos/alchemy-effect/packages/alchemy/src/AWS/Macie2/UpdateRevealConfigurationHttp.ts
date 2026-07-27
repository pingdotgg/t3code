import * as macie2 from "@distilled.cloud/aws/macie2";
import * as Layer from "effect/Layer";
import { makeMacie2HttpBinding } from "./BindingHttp.ts";
import { UpdateRevealConfiguration } from "./UpdateRevealConfiguration.ts";

export const UpdateRevealConfigurationHttp = Layer.effect(
  UpdateRevealConfiguration,
  makeMacie2HttpBinding({
    tag: "AWS.Macie2.UpdateRevealConfiguration",
    operation: macie2.updateRevealConfiguration,
    actions: ["macie2:UpdateRevealConfiguration"],
  }),
);
