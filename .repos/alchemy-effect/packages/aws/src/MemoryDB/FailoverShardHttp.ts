import * as memorydb from "@distilled.cloud/aws/memorydb";
import * as Layer from "effect/Layer";
import { makeMemoryDBClusterHttpBinding } from "./BindingHttp.ts";
import { FailoverShard } from "./FailoverShard.ts";

export const FailoverShardHttp = Layer.effect(
  FailoverShard,
  makeMemoryDBClusterHttpBinding({
    tag: "AWS.MemoryDB.FailoverShard",
    operation: memorydb.failoverShard,
    actions: ["memorydb:FailoverShard"],
  }),
);
