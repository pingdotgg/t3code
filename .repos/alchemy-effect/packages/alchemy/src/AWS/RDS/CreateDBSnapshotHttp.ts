import * as rds from "@distilled.cloud/aws/rds";
import * as Layer from "effect/Layer";
import { makeRdsInstanceHttpBinding } from "./BindingHttp.ts";
import { CreateDBSnapshot } from "./CreateDBSnapshot.ts";

export const CreateDBSnapshotHttp = Layer.effect(
  CreateDBSnapshot,
  makeRdsInstanceHttpBinding({
    tag: "AWS.RDS.CreateDBSnapshot",
    operation: rds.createDBSnapshot,
    actions: ["rds:CreateDBSnapshot", "rds:AddTagsToResource"],
    // Snapshot creation authorizes against BOTH the source ARN and the
    // target snapshot ARN — widen the grant to the account's
    // `snapshot` ARN space.
    extraResources: (arn) => [
      `${arn.split(":").slice(0, 5).join(":")}:snapshot:*`,
    ],
  }),
);
