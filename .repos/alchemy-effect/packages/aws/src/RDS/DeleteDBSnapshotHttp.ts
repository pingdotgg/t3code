import * as rds from "@distilled.cloud/aws/rds";
import * as Layer from "effect/Layer";
import { makeRdsAccountHttpBinding } from "./BindingHttp.ts";
import { DeleteDBSnapshot } from "./DeleteDBSnapshot.ts";

export const DeleteDBSnapshotHttp = Layer.effect(
  DeleteDBSnapshot,
  makeRdsAccountHttpBinding({
    tag: "AWS.RDS.DeleteDBSnapshot",
    operation: rds.deleteDBSnapshot,
    actions: ["rds:DeleteDBSnapshot"],
  }),
);
