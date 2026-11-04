import * as neptune from "@distilled.cloud/aws/neptune";
import * as Layer from "effect/Layer";
import { makeNeptuneClusterHttpBinding } from "./BindingHttp.ts";
import { CreateDBClusterSnapshot } from "./CreateDBClusterSnapshot.ts";

export const CreateDBClusterSnapshotHttp = Layer.effect(
  CreateDBClusterSnapshot,
  makeNeptuneClusterHttpBinding({
    tag: "AWS.Neptune.CreateDBClusterSnapshot",
    operation: neptune.createDBClusterSnapshot,
    actions: ["rds:CreateDBClusterSnapshot", "rds:AddTagsToResource"],
    // Snapshot creation authorizes against BOTH the source cluster ARN and
    // the target snapshot ARN — widen the grant to the account's Neptune
    // cluster-snapshot space (`arn:…:rds:{region}:{account}:cluster-snapshot:*`).
    extraResources: (clusterArn) => [
      `${clusterArn.split(":").slice(0, 5).join(":")}:cluster-snapshot:*`,
    ],
  }),
);
