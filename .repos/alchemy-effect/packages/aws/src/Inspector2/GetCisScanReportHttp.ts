import * as inspector2 from "@distilled.cloud/aws/inspector2";
import * as Layer from "effect/Layer";
import { makeInspector2AccountHttpBinding } from "./BindingHttp.ts";
import { GetCisScanReport } from "./GetCisScanReport.ts";

export const GetCisScanReportHttp = Layer.effect(
  GetCisScanReport,
  makeInspector2AccountHttpBinding({
    tag: "AWS.Inspector2.GetCisScanReport",
    operation: inspector2.getCisScanReport,
    actions: ["inspector2:GetCisScanReport"],
  }),
);
