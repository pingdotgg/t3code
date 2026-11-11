import * as macie2 from "@distilled.cloud/aws/macie2";
import * as Layer from "effect/Layer";
import { makeMacie2HttpBinding } from "./BindingHttp.ts";
import { GetSensitiveDataOccurrences } from "./GetSensitiveDataOccurrences.ts";

export const GetSensitiveDataOccurrencesHttp = Layer.effect(
  GetSensitiveDataOccurrences,
  makeMacie2HttpBinding({
    tag: "AWS.Macie2.GetSensitiveDataOccurrences",
    operation: macie2.getSensitiveDataOccurrences,
    actions: ["macie2:GetSensitiveDataOccurrences"],
  }),
);
