import * as ivs from "@distilled.cloud/aws/ivs";
import * as Layer from "effect/Layer";
import { makeIvsAccountHttpBinding } from "./BindingHttp.ts";
import { ListStreams } from "./ListStreams.ts";

export const ListStreamsHttp = Layer.effect(
  ListStreams,
  makeIvsAccountHttpBinding({
    tag: "AWS.IVS.ListStreams",
    operation: ivs.listStreams,
    actions: ["ivs:ListStreams"],
  }),
);
