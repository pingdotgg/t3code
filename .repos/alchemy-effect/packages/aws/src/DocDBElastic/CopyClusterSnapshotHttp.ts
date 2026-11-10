import * as docdbelastic from "@distilled.cloud/aws/docdb-elastic";
import * as Layer from "effect/Layer";
import { makeDocDBElasticAccountHttpBinding } from "./BindingHttp.ts";
import { CopyClusterSnapshot } from "./CopyClusterSnapshot.ts";

export const CopyClusterSnapshotHttp = Layer.effect(
  CopyClusterSnapshot,
  makeDocDBElasticAccountHttpBinding({
    tag: "AWS.DocDBElastic.CopyClusterSnapshot",
    operation: docdbelastic.copyClusterSnapshot,
    actions: [
      "docdb-elastic:CopyClusterSnapshot",
      // Copying authorizes the creation of the target snapshot as a
      // CreateClusterSnapshot on `cluster-snapshot/*` (verified live: without
      // it the service returns AccessDeniedException naming this action).
      "docdb-elastic:CreateClusterSnapshot",
      "docdb-elastic:TagResource",
    ],
  }),
);
