import * as inspector2 from "@distilled.cloud/aws/inspector2";
import * as Layer from "effect/Layer";
import { makeInspector2AccountHttpBinding } from "./BindingHttp.ts";
import { CreateFindingsReport } from "./CreateFindingsReport.ts";

export const CreateFindingsReportHttp = Layer.effect(
  CreateFindingsReport,
  makeInspector2AccountHttpBinding({
    tag: "AWS.Inspector2.CreateFindingsReport",
    operation: inspector2.createFindingsReport,
    actions: ["inspector2:CreateFindingsReport"],
  }),
);
