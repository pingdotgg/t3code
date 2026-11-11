import * as kendra from "@distilled.cloud/aws/kendra";
import * as Layer from "effect/Layer";
import { makeKendraDataSourceHttpBinding } from "./BindingHttp.ts";
import { ListDataSourceSyncJobs } from "./ListDataSourceSyncJobs.ts";

export const ListDataSourceSyncJobsHttp = Layer.effect(
  ListDataSourceSyncJobs,
  makeKendraDataSourceHttpBinding({
    tag: "AWS.Kendra.ListDataSourceSyncJobs",
    operation: kendra.listDataSourceSyncJobs,
    actions: ["kendra:ListDataSourceSyncJobs"],
  }),
);
