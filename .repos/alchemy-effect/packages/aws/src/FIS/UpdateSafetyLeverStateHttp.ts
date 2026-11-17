import * as fis from "@distilled.cloud/aws/fis";
import * as Layer from "effect/Layer";
import { makeFisAccountHttpBinding } from "./BindingHttp.ts";
import { UpdateSafetyLeverState } from "./UpdateSafetyLeverState.ts";

export const UpdateSafetyLeverStateHttp = Layer.effect(
  UpdateSafetyLeverState,
  makeFisAccountHttpBinding({
    tag: "AWS.FIS.UpdateSafetyLeverState",
    operation: fis.updateSafetyLeverState,
    actions: ["fis:UpdateSafetyLeverState"],
  }),
);
