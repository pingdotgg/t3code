import * as memorydb from "@distilled.cloud/aws/memorydb";
import * as Layer from "effect/Layer";
import { makeMemoryDBClusterHttpBinding } from "./BindingHttp.ts";
import { ListAllowedNodeTypeUpdates } from "./ListAllowedNodeTypeUpdates.ts";

export const ListAllowedNodeTypeUpdatesHttp = Layer.effect(
  ListAllowedNodeTypeUpdates,
  makeMemoryDBClusterHttpBinding({
    tag: "AWS.MemoryDB.ListAllowedNodeTypeUpdates",
    operation: memorydb.listAllowedNodeTypeUpdates,
    actions: ["memorydb:ListAllowedNodeTypeUpdates"],
  }),
);
