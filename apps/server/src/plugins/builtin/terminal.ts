import * as Layer from "effect/Layer";
import * as NodePtyAdapter from "../../terminal/NodePtyAdapter.ts";
import * as TerminalManager from "../../terminal/Manager.ts";
import * as ProviderInstanceRegistryHydration from "../../provider/ProviderInstanceRegistryHydration.ts";
import { layerNativeTelemetry } from "./resources.ts";
import { layerPortScanner } from "./preview.ts";

export const layerPtyAdapter = NodePtyAdapter.layer;

export const layerTerminal = TerminalManager.layer(
  ProviderInstanceRegistryHydration.deriveProviderInstanceConfigMap,
).pipe(
  Layer.provide(layerPtyAdapter),
  Layer.provide(layerPortScanner),
  Layer.provide(layerNativeTelemetry),
);
