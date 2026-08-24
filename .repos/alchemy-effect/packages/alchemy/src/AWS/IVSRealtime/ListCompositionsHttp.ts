import * as ivsrealtime from "@distilled.cloud/aws/ivs-realtime";
import * as Layer from "effect/Layer";
import { makeIvsRealtimeAccountHttpBinding } from "./BindingHttp.ts";
import { ListCompositions } from "./ListCompositions.ts";

export const ListCompositionsHttp = Layer.effect(
  ListCompositions,
  makeIvsRealtimeAccountHttpBinding({
    tag: "AWS.IVSRealtime.ListCompositions",
    operation: ivsrealtime.listCompositions,
    actions: ["ivs:ListCompositions"],
  }),
);
