import * as glue from "@distilled.cloud/aws/glue";
import * as Layer from "effect/Layer";
import { makeGlueJobHttpBinding } from "./BindingHttp.ts";
import { GetJobRuns } from "./GetJobRuns.ts";

export const GetJobRunsHttp = Layer.effect(
  GetJobRuns,
  makeGlueJobHttpBinding({
    tag: "AWS.Glue.GetJobRuns",
    operation: glue.getJobRuns,
    actions: ["glue:GetJobRuns"],
  }),
);
