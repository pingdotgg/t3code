import * as controltower from "@distilled.cloud/aws/controltower";
import * as Layer from "effect/Layer";
import { makeControlTowerAccountHttpBinding } from "./BindingHttp.ts";
import { ListEnabledControls } from "./ListEnabledControls.ts";

export const ListEnabledControlsHttp = Layer.effect(
  ListEnabledControls,
  makeControlTowerAccountHttpBinding({
    capability: "ListEnabledControls",
    iamActions: ["controltower:ListEnabledControls"],
    operation: controltower.listEnabledControls,
  }),
);
