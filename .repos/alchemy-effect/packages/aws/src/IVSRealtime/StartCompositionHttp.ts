import * as ivsrealtime from "@distilled.cloud/aws/ivs-realtime";
import * as Layer from "effect/Layer";
import {
  COMPOSITION_ARN_WILDCARD,
  ENCODER_CONFIGURATION_ARN_WILDCARD,
  makeIvsRealtimeStageHttpBinding,
  STORAGE_CONFIGURATION_ARN_WILDCARD,
} from "./BindingHttp.ts";
import { StartComposition } from "./StartComposition.ts";

export const StartCompositionHttp = Layer.effect(
  StartComposition,
  makeIvsRealtimeStageHttpBinding({
    tag: "AWS.IVSRealtime.StartComposition",
    operation: ivsrealtime.startComposition,
    actions: ["ivs:StartComposition"],
    // The created composition and any referenced encoder/storage
    // configurations are runtime data.
    extraResources: [
      COMPOSITION_ARN_WILDCARD,
      ENCODER_CONFIGURATION_ARN_WILDCARD,
      STORAGE_CONFIGURATION_ARN_WILDCARD,
    ],
  }),
);
