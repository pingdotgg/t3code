import * as qbusiness from "@distilled.cloud/aws/qbusiness";
import * as Layer from "effect/Layer";
import { makeQBusinessDataSourceHttpBinding } from "./BindingHttp.ts";
import { ListDataSourceSyncJobs } from "./ListDataSourceSyncJobs.ts";

export const ListDataSourceSyncJobsHttp = Layer.effect(
  ListDataSourceSyncJobs,
  makeQBusinessDataSourceHttpBinding({
    tag: "AWS.QBusiness.ListDataSourceSyncJobs",
    operation: qbusiness.listDataSourceSyncJobs,
    actions: ["qbusiness:ListDataSourceSyncJobs"],
  }),
);
