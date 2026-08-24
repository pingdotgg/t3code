import * as rds from "@distilled.cloud/aws/rds";
import * as Layer from "effect/Layer";
import { makeRdsClusterHttpBinding } from "./BindingHttp.ts";
import { CreateDBClusterSnapshot } from "./CreateDBClusterSnapshot.ts";

export const CreateDBClusterSnapshotHttp = Layer.effect(
  CreateDBClusterSnapshot,
  makeRdsClusterHttpBinding({
    tag: "AWS.RDS.CreateDBClusterSnapshot",
    operation: rds.createDBClusterSnapshot,
    actions: ["rds:CreateDBClusterSnapshot", "rds:AddTagsToResource"],
    // Snapshot creation authorizes against BOTH the source ARN and the
    // target snapshot ARN — widen the grant to the account's
    // `cluster-snapshot` ARN space.
    extraResources: (arn) => [
      `${arn.split(":").slice(0, 5).join(":")}:cluster-snapshot:*`,
    ],
  }),
);
