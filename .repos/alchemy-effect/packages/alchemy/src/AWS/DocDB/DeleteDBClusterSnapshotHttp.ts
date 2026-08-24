import * as docdb from "@distilled.cloud/aws/docdb";
import * as Layer from "effect/Layer";
import { makeDocDBAccountHttpBinding } from "./BindingHttp.ts";
import { DeleteDBClusterSnapshot } from "./DeleteDBClusterSnapshot.ts";

export const DeleteDBClusterSnapshotHttp = Layer.effect(
  DeleteDBClusterSnapshot,
  makeDocDBAccountHttpBinding({
    tag: "AWS.DocDB.DeleteDBClusterSnapshot",
    operation: docdb.deleteDBClusterSnapshot,
    actions: ["rds:DeleteDBClusterSnapshot"],
  }),
);
