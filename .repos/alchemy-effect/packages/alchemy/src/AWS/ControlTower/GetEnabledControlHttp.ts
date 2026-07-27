import * as controltower from "@distilled.cloud/aws/controltower";
import * as Layer from "effect/Layer";
import { makeControlTowerHttpBinding } from "./BindingHttp.ts";
import type { EnabledControl } from "./EnabledControl.ts";
import { GetEnabledControl } from "./GetEnabledControl.ts";

export const GetEnabledControlHttp = Layer.effect(
  GetEnabledControl,
  makeControlTowerHttpBinding({
    capability: "GetEnabledControl",
    iamActions: ["controltower:GetEnabledControl"],
    requestKey: "enabledControlIdentifier",
    identifier: (enabledControl: EnabledControl) =>
      enabledControl.enabledControlArn,
    operation: controltower.getEnabledControl,
  }),
);
