import * as ivsrealtime from "@distilled.cloud/aws/ivs-realtime";
import * as Layer from "effect/Layer";
import {
  COMPOSITION_ARN_WILDCARD,
  makeIvsRealtimeAccountHttpBinding,
} from "./BindingHttp.ts";
import { StopComposition } from "./StopComposition.ts";

export const StopCompositionHttp = Layer.effect(
  StopComposition,
  makeIvsRealtimeAccountHttpBinding({
    tag: "AWS.IVSRealtime.StopComposition",
    operation: ivsrealtime.stopComposition,
    actions: ["ivs:StopComposition"],
    resources: [COMPOSITION_ARN_WILDCARD],
  }),
);
