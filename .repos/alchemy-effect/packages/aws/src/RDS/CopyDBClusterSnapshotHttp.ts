import * as rds from "@distilled.cloud/aws/rds";
import * as Layer from "effect/Layer";
import { makeRdsAccountHttpBinding } from "./BindingHttp.ts";
import { CopyDBClusterSnapshot } from "./CopyDBClusterSnapshot.ts";

export const CopyDBClusterSnapshotHttp = Layer.effect(
  CopyDBClusterSnapshot,
  makeRdsAccountHttpBinding({
    tag: "AWS.RDS.CopyDBClusterSnapshot",
    operation: rds.copyDBClusterSnapshot,
    actions: ["rds:CopyDBClusterSnapshot", "rds:AddTagsToResource"],
  }),
);
