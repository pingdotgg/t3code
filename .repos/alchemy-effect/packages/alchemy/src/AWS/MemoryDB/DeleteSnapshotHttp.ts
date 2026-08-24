import * as memorydb from "@distilled.cloud/aws/memorydb";
import * as Layer from "effect/Layer";
import {
  makeMemoryDBAccountHttpBinding,
  SNAPSHOT_ARN_WILDCARD,
} from "./BindingHttp.ts";
import { DeleteSnapshot } from "./DeleteSnapshot.ts";

export const DeleteSnapshotHttp = Layer.effect(
  DeleteSnapshot,
  makeMemoryDBAccountHttpBinding({
    tag: "AWS.MemoryDB.DeleteSnapshot",
    operation: memorydb.deleteSnapshot,
    actions: ["memorydb:DeleteSnapshot"],
    resources: [SNAPSHOT_ARN_WILDCARD],
  }),
);
