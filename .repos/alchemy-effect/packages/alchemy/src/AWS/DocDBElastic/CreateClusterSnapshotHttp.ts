import * as docdbelastic from "@distilled.cloud/aws/docdb-elastic";
import * as Layer from "effect/Layer";
import {
  makeDocDBElasticClusterHttpBinding,
  SNAPSHOT_ARN_WILDCARD,
} from "./BindingHttp.ts";
import { CreateClusterSnapshot } from "./CreateClusterSnapshot.ts";

export const CreateClusterSnapshotHttp = Layer.effect(
  CreateClusterSnapshot,
  makeDocDBElasticClusterHttpBinding({
    tag: "AWS.DocDBElastic.CreateClusterSnapshot",
    operation: docdbelastic.createClusterSnapshot,
    actions: [
      "docdb-elastic:CreateClusterSnapshot",
      "docdb-elastic:TagResource",
    ],
    // The action authorizes against both the source cluster and the
    // to-be-created snapshot (whose UUID-based ARN is server-generated).
    extraResources: [SNAPSHOT_ARN_WILDCARD],
  }),
);
