import * as controltower from "@distilled.cloud/aws/controltower";
import * as Layer from "effect/Layer";
import { makeControlTowerHttpBinding } from "./BindingHttp.ts";
import type { EnabledControl } from "./EnabledControl.ts";
import { ResetEnabledControl } from "./ResetEnabledControl.ts";

export const ResetEnabledControlHttp = Layer.effect(
  ResetEnabledControl,
  makeControlTowerHttpBinding({
    capability: "ResetEnabledControl",
    iamActions: ["controltower:ResetEnabledControl"],
    requestKey: "enabledControlIdentifier",
    identifier: (enabledControl: EnabledControl) =>
      enabledControl.enabledControlArn,
    operation: controltower.resetEnabledControl,
  }),
);
