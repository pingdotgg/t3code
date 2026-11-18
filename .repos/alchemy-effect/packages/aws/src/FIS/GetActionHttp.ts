import * as fis from "@distilled.cloud/aws/fis";
import * as Layer from "effect/Layer";
import { makeFisAccountHttpBinding } from "./BindingHttp.ts";
import { GetAction } from "./GetAction.ts";

export const GetActionHttp = Layer.effect(
  GetAction,
  makeFisAccountHttpBinding({
    tag: "AWS.FIS.GetAction",
    operation: fis.getAction,
    actions: ["fis:GetAction"],
  }),
);
