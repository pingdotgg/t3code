import * as glue from "@distilled.cloud/aws/glue";
import * as Layer from "effect/Layer";
import { makeGlueJobHttpBinding } from "./BindingHttp.ts";
import { StartJobRun } from "./StartJobRun.ts";

export const StartJobRunHttp = Layer.effect(
  StartJobRun,
  makeGlueJobHttpBinding({
    tag: "AWS.Glue.StartJobRun",
    operation: glue.startJobRun,
    actions: ["glue:StartJobRun", "glue:GetJobRun"],
  }),
);
