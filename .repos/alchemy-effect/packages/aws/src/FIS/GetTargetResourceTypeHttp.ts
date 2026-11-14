import * as fis from "@distilled.cloud/aws/fis";
import * as Layer from "effect/Layer";
import { makeFisAccountHttpBinding } from "./BindingHttp.ts";
import { GetTargetResourceType } from "./GetTargetResourceType.ts";

export const GetTargetResourceTypeHttp = Layer.effect(
  GetTargetResourceType,
  makeFisAccountHttpBinding({
    tag: "AWS.FIS.GetTargetResourceType",
    operation: fis.getTargetResourceType,
    actions: ["fis:GetTargetResourceType"],
  }),
);
