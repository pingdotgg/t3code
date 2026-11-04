import * as redshift from "@distilled.cloud/aws/redshift";
import * as Layer from "effect/Layer";
import { makeRedshiftAccountHttpBinding } from "./BindingHttp.ts";
import { DeleteClusterSnapshot } from "./DeleteClusterSnapshot.ts";

export const DeleteClusterSnapshotHttp = Layer.effect(
  DeleteClusterSnapshot,
  makeRedshiftAccountHttpBinding({
    tag: "AWS.Redshift.DeleteClusterSnapshot",
    operation: redshift.deleteClusterSnapshot,
    actions: ["redshift:DeleteClusterSnapshot"],
  }),
);
