import * as inspector2 from "@distilled.cloud/aws/inspector2";
import * as Layer from "effect/Layer";
import { makeInspector2AccountHttpBinding } from "./BindingHttp.ts";
import { CancelFindingsReport } from "./CancelFindingsReport.ts";

export const CancelFindingsReportHttp = Layer.effect(
  CancelFindingsReport,
  makeInspector2AccountHttpBinding({
    tag: "AWS.Inspector2.CancelFindingsReport",
    operation: inspector2.cancelFindingsReport,
    actions: ["inspector2:CancelFindingsReport"],
  }),
);
