import * as ivsrealtime from "@distilled.cloud/aws/ivs-realtime";
import * as Layer from "effect/Layer";
import {
  COMPOSITION_ARN_WILDCARD,
  makeIvsRealtimeAccountHttpBinding,
} from "./BindingHttp.ts";
import { GetComposition } from "./GetComposition.ts";

export const GetCompositionHttp = Layer.effect(
  GetComposition,
  makeIvsRealtimeAccountHttpBinding({
    tag: "AWS.IVSRealtime.GetComposition",
    operation: ivsrealtime.getComposition,
    actions: ["ivs:GetComposition"],
    resources: [COMPOSITION_ARN_WILDCARD],
  }),
);
