import * as backupsearch from "@distilled.cloud/aws/backupsearch";
import * as Layer from "effect/Layer";
import { makeSearchJobScopedHttpBinding } from "./BindingHttp.ts";
import { ListSearchJobBackups } from "./ListSearchJobBackups.ts";

export const ListSearchJobBackupsHttp = Layer.effect(
  ListSearchJobBackups,
  makeSearchJobScopedHttpBinding({
    tag: "AWS.BackupSearch.ListSearchJobBackups",
    operation: backupsearch.listSearchJobBackups,
    actions: ["backup-search:ListSearchJobBackups"],
  }),
);
