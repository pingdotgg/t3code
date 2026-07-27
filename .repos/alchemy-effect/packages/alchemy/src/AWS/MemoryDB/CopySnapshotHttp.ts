import * as memorydb from "@distilled.cloud/aws/memorydb";
import * as Layer from "effect/Layer";
import {
  makeMemoryDBAccountHttpBinding,
  SNAPSHOT_ARN_WILDCARD,
} from "./BindingHttp.ts";
import { CopySnapshot } from "./CopySnapshot.ts";

export const CopySnapshotHttp = Layer.effect(
  CopySnapshot,
  makeMemoryDBAccountHttpBinding({
    tag: "AWS.MemoryDB.CopySnapshot",
    operation: memorydb.copySnapshot,
    // TagResource authorizes tag-on-create for the target snapshot.
    actions: ["memorydb:CopySnapshot", "memorydb:TagResource"],
    // Both the source and target snapshot names are runtime data.
    resources: [SNAPSHOT_ARN_WILDCARD],
  }),
);
