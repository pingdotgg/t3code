import * as controltower from "@distilled.cloud/aws/controltower";
import * as Layer from "effect/Layer";
import { makeControlTowerHttpBinding } from "./BindingHttp.ts";
import type { EnabledBaseline } from "./EnabledBaseline.ts";
import { ResetEnabledBaseline } from "./ResetEnabledBaseline.ts";

export const ResetEnabledBaselineHttp = Layer.effect(
  ResetEnabledBaseline,
  makeControlTowerHttpBinding({
    capability: "ResetEnabledBaseline",
    iamActions: ["controltower:ResetEnabledBaseline"],
    requestKey: "enabledBaselineIdentifier",
    identifier: (enabledBaseline: EnabledBaseline) =>
      enabledBaseline.enabledBaselineArn,
    operation: controltower.resetEnabledBaseline,
  }),
);
