import * as macie2 from "@distilled.cloud/aws/macie2";
import * as Layer from "effect/Layer";
import { makeMacie2HttpBinding } from "./BindingHttp.ts";
import { GetSensitiveDataOccurrencesAvailability } from "./GetSensitiveDataOccurrencesAvailability.ts";

export const GetSensitiveDataOccurrencesAvailabilityHttp = Layer.effect(
  GetSensitiveDataOccurrencesAvailability,
  makeMacie2HttpBinding({
    tag: "AWS.Macie2.GetSensitiveDataOccurrencesAvailability",
    operation: macie2.getSensitiveDataOccurrencesAvailability,
    actions: ["macie2:GetSensitiveDataOccurrencesAvailability"],
  }),
);
