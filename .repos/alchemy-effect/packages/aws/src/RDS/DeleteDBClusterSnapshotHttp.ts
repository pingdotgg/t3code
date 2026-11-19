import * as rds from "@distilled.cloud/aws/rds";
import * as Layer from "effect/Layer";
import { makeRdsAccountHttpBinding } from "./BindingHttp.ts";
import { DeleteDBClusterSnapshot } from "./DeleteDBClusterSnapshot.ts";

export const DeleteDBClusterSnapshotHttp = Layer.effect(
  DeleteDBClusterSnapshot,
  makeRdsAccountHttpBinding({
    tag: "AWS.RDS.DeleteDBClusterSnapshot",
    operation: rds.deleteDBClusterSnapshot,
    actions: ["rds:DeleteDBClusterSnapshot"],
  }),
);
