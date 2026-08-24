import * as docdbelastic from "@distilled.cloud/aws/docdb-elastic";
import * as Layer from "effect/Layer";
import { makeDocDBElasticAccountHttpBinding } from "./BindingHttp.ts";
import { ListClusterSnapshots } from "./ListClusterSnapshots.ts";

export const ListClusterSnapshotsHttp = Layer.effect(
  ListClusterSnapshots,
  makeDocDBElasticAccountHttpBinding({
    tag: "AWS.DocDBElastic.ListClusterSnapshots",
    operation: docdbelastic.listClusterSnapshots,
    actions: ["docdb-elastic:ListClusterSnapshots"],
  }),
);
