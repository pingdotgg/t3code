import * as backupsearch from "@distilled.cloud/aws/backupsearch";
import * as Layer from "effect/Layer";
import { makeSearchJobScopedHttpBinding } from "./BindingHttp.ts";
import { ListSearchJobResults } from "./ListSearchJobResults.ts";

export const ListSearchJobResultsHttp = Layer.effect(
  ListSearchJobResults,
  makeSearchJobScopedHttpBinding({
    tag: "AWS.BackupSearch.ListSearchJobResults",
    operation: backupsearch.listSearchJobResults,
    actions: ["backup-search:ListSearchJobResults"],
  }),
);
