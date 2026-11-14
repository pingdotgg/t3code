import * as fis from "@distilled.cloud/aws/fis";
import * as Layer from "effect/Layer";
import { makeFisAccountHttpBinding } from "./BindingHttp.ts";
import { GetSafetyLever } from "./GetSafetyLever.ts";

export const GetSafetyLeverHttp = Layer.effect(
  GetSafetyLever,
  makeFisAccountHttpBinding({
    tag: "AWS.FIS.GetSafetyLever",
    operation: fis.getSafetyLever,
    actions: ["fis:GetSafetyLever"],
  }),
);
