import * as backupsearch from "@distilled.cloud/aws/backupsearch";
import * as Layer from "effect/Layer";
import { makeSearchJobScopedHttpBinding } from "./BindingHttp.ts";
import { GetSearchJob } from "./GetSearchJob.ts";

export const GetSearchJobHttp = Layer.effect(
  GetSearchJob,
  makeSearchJobScopedHttpBinding({
    tag: "AWS.BackupSearch.GetSearchJob",
    operation: backupsearch.getSearchJob,
    actions: ["backup-search:GetSearchJob"],
  }),
);
