import * as inspector2 from "@distilled.cloud/aws/inspector2";
import * as Layer from "effect/Layer";
import { makeInspector2AccountHttpBinding } from "./BindingHttp.ts";
import { GetCodeSecurityScan } from "./GetCodeSecurityScan.ts";

export const GetCodeSecurityScanHttp = Layer.effect(
  GetCodeSecurityScan,
  makeInspector2AccountHttpBinding({
    tag: "AWS.Inspector2.GetCodeSecurityScan",
    operation: inspector2.getCodeSecurityScan,
    actions: ["inspector2:GetCodeSecurityScan"],
  }),
);
