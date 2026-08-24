import * as controltower from "@distilled.cloud/aws/controltower";
import * as Layer from "effect/Layer";
import { makeControlTowerHttpBinding } from "./BindingHttp.ts";
import type { EnabledBaseline } from "./EnabledBaseline.ts";
import { GetEnabledBaseline } from "./GetEnabledBaseline.ts";

export const GetEnabledBaselineHttp = Layer.effect(
  GetEnabledBaseline,
  makeControlTowerHttpBinding({
    capability: "GetEnabledBaseline",
    iamActions: ["controltower:GetEnabledBaseline"],
    requestKey: "enabledBaselineIdentifier",
    identifier: (enabledBaseline: EnabledBaseline) =>
      enabledBaseline.enabledBaselineArn,
    operation: controltower.getEnabledBaseline,
  }),
);
