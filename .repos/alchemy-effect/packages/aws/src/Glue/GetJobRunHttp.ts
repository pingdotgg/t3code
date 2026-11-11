import * as glue from "@distilled.cloud/aws/glue";
import * as Layer from "effect/Layer";
import { makeGlueJobHttpBinding } from "./BindingHttp.ts";
import { GetJobRun } from "./GetJobRun.ts";

export const GetJobRunHttp = Layer.effect(
  GetJobRun,
  makeGlueJobHttpBinding({
    tag: "AWS.Glue.GetJobRun",
    operation: glue.getJobRun,
    actions: ["glue:GetJobRun"],
  }),
);
