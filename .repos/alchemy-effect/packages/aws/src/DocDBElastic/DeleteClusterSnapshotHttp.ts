import * as docdbelastic from "@distilled.cloud/aws/docdb-elastic";
import * as Layer from "effect/Layer";
import { makeDocDBElasticAccountHttpBinding } from "./BindingHttp.ts";
import { DeleteClusterSnapshot } from "./DeleteClusterSnapshot.ts";

export const DeleteClusterSnapshotHttp = Layer.effect(
  DeleteClusterSnapshot,
  makeDocDBElasticAccountHttpBinding({
    tag: "AWS.DocDBElastic.DeleteClusterSnapshot",
    operation: docdbelastic.deleteClusterSnapshot,
    actions: ["docdb-elastic:DeleteClusterSnapshot"],
  }),
);
