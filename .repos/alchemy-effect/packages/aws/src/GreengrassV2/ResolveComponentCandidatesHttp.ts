import * as greengrassv2 from "@distilled.cloud/aws/greengrassv2";
import * as Layer from "effect/Layer";
import { makeGreengrassAccountHttpBinding } from "./BindingHttp.ts";
import { ResolveComponentCandidates } from "./ResolveComponentCandidates.ts";

export const ResolveComponentCandidatesHttp = Layer.effect(
  ResolveComponentCandidates,
  makeGreengrassAccountHttpBinding({
    tag: "AWS.GreengrassV2.ResolveComponentCandidates",
    operation: greengrassv2.resolveComponentCandidates,
    actions: ["greengrass:ResolveComponentCandidates"],
  }),
);
