import * as kendra from "@distilled.cloud/aws/kendra";
import * as Layer from "effect/Layer";
import { makeKendraDataSourceHttpBinding } from "./BindingHttp.ts";
import { StartDataSourceSyncJob } from "./StartDataSourceSyncJob.ts";

export const StartDataSourceSyncJobHttp = Layer.effect(
  StartDataSourceSyncJob,
  makeKendraDataSourceHttpBinding({
    tag: "AWS.Kendra.StartDataSourceSyncJob",
    operation: kendra.startDataSourceSyncJob,
    actions: ["kendra:StartDataSourceSyncJob"],
  }),
);
