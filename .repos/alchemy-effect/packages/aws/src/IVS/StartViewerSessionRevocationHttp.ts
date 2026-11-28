import * as ivs from "@distilled.cloud/aws/ivs";
import * as Layer from "effect/Layer";
import { makeIvsChannelHttpBinding } from "./BindingHttp.ts";
import { StartViewerSessionRevocation } from "./StartViewerSessionRevocation.ts";

export const StartViewerSessionRevocationHttp = Layer.effect(
  StartViewerSessionRevocation,
  makeIvsChannelHttpBinding({
    tag: "AWS.IVS.StartViewerSessionRevocation",
    operation: ivs.startViewerSessionRevocation,
    actions: ["ivs:StartViewerSessionRevocation"],
  }),
);
