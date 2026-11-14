import * as qbusiness from "@distilled.cloud/aws/qbusiness";
import * as Layer from "effect/Layer";
import { makeQBusinessDataSourceHttpBinding } from "./BindingHttp.ts";
import { StartDataSourceSyncJob } from "./StartDataSourceSyncJob.ts";

export const StartDataSourceSyncJobHttp = Layer.effect(
  StartDataSourceSyncJob,
  makeQBusinessDataSourceHttpBinding({
    tag: "AWS.QBusiness.StartDataSourceSyncJob",
    operation: qbusiness.startDataSourceSyncJob,
    actions: ["qbusiness:StartDataSourceSyncJob"],
  }),
);
