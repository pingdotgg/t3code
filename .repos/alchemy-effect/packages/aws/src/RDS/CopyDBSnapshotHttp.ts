import * as rds from "@distilled.cloud/aws/rds";
import * as Layer from "effect/Layer";
import { makeRdsAccountHttpBinding } from "./BindingHttp.ts";
import { CopyDBSnapshot } from "./CopyDBSnapshot.ts";

export const CopyDBSnapshotHttp = Layer.effect(
  CopyDBSnapshot,
  makeRdsAccountHttpBinding({
    tag: "AWS.RDS.CopyDBSnapshot",
    operation: rds.copyDBSnapshot,
    actions: ["rds:CopyDBSnapshot", "rds:AddTagsToResource"],
  }),
);
