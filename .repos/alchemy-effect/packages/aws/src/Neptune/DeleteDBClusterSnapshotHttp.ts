import * as neptune from "@distilled.cloud/aws/neptune";
import * as Layer from "effect/Layer";
import { makeNeptuneAccountHttpBinding } from "./BindingHttp.ts";
import { DeleteDBClusterSnapshot } from "./DeleteDBClusterSnapshot.ts";

export const DeleteDBClusterSnapshotHttp = Layer.effect(
  DeleteDBClusterSnapshot,
  makeNeptuneAccountHttpBinding({
    tag: "AWS.Neptune.DeleteDBClusterSnapshot",
    operation: neptune.deleteDBClusterSnapshot,
    actions: ["rds:DeleteDBClusterSnapshot"],
  }),
);
