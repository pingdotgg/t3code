import * as memorydb from "@distilled.cloud/aws/memorydb";
import * as Layer from "effect/Layer";
import {
  makeMemoryDBClusterHttpBinding,
  SNAPSHOT_ARN_WILDCARD,
} from "./BindingHttp.ts";
import { CreateSnapshot } from "./CreateSnapshot.ts";

export const CreateSnapshotHttp = Layer.effect(
  CreateSnapshot,
  makeMemoryDBClusterHttpBinding({
    tag: "AWS.MemoryDB.CreateSnapshot",
    operation: memorydb.createSnapshot,
    // TagResource authorizes tag-on-create for the snapshot.
    actions: ["memorydb:CreateSnapshot", "memorydb:TagResource"],
    // The action authorizes against both the source cluster and the
    // to-be-created snapshot (whose name-based ARN is runtime data).
    extraResources: [SNAPSHOT_ARN_WILDCARD],
  }),
);
