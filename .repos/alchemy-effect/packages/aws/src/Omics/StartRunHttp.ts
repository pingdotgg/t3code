import * as omics from "@distilled.cloud/aws/omics";
import * as Layer from "effect/Layer";
import { makeOmicsResourceHttpBinding } from "./BindingHttp.ts";
import { StartRun } from "./StartRun.ts";
import type { Workflow } from "./Workflow.ts";

export const StartRunHttp = Layer.effect(
  StartRun,
  makeOmicsResourceHttpBinding({
    tag: "AWS.Omics.StartRun",
    operation: omics.startRun,
    actions: ["omics:StartRun"],
    key: "workflowId",
    id: (workflow: Workflow) => workflow.workflowId,
    arn: (workflow: Workflow) => workflow.workflowArn,
    passRole: true,
  }),
);
