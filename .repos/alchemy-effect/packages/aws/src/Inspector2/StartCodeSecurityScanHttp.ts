import * as inspector2 from "@distilled.cloud/aws/inspector2";
import * as Layer from "effect/Layer";
import { makeInspector2AccountHttpBinding } from "./BindingHttp.ts";
import { StartCodeSecurityScan } from "./StartCodeSecurityScan.ts";

export const StartCodeSecurityScanHttp = Layer.effect(
  StartCodeSecurityScan,
  makeInspector2AccountHttpBinding({
    tag: "AWS.Inspector2.StartCodeSecurityScan",
    operation: inspector2.startCodeSecurityScan,
    actions: ["inspector2:StartCodeSecurityScan"],
  }),
);
