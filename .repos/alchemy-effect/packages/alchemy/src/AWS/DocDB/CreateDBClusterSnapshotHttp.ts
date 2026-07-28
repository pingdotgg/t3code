import * as docdb from "@distilled.cloud/aws/docdb";
import * as Layer from "effect/Layer";
import { makeDocDBClusterHttpBinding } from "./BindingHttp.ts";
import { CreateDBClusterSnapshot } from "./CreateDBClusterSnapshot.ts";

export const CreateDBClusterSnapshotHttp = Layer.effect(
  CreateDBClusterSnapshot,
  makeDocDBClusterHttpBinding({
    tag: "AWS.DocDB.CreateDBClusterSnapshot",
    operation: docdb.createDBClusterSnapshot,
    actions: ["rds:CreateDBClusterSnapshot", "rds:AddTagsToResource"],
    // Snapshot creation authorizes against BOTH the source cluster ARN and
    // the target snapshot ARN — widen the grant to the account's DocumentDB
    // cluster-snapshot space (`arn:…:rds:{region}:{account}:cluster-snapshot:*`).
    extraResources: (clusterArn) => [
      `${clusterArn.split(":").slice(0, 5).join(":")}:cluster-snapshot:*`,
    ],
  }),
);
