import * as elasticache from "@distilled.cloud/aws/elasticache";
import * as Layer from "effect/Layer";
import {
  makeElastiCacheAccountHttpBinding,
  SERVERLESS_SNAPSHOT_ARN_WILDCARD,
} from "./BindingHttp.ts";
import { DeleteServerlessCacheSnapshot } from "./DeleteServerlessCacheSnapshot.ts";

export const DeleteServerlessCacheSnapshotHttp = Layer.effect(
  DeleteServerlessCacheSnapshot,
  makeElastiCacheAccountHttpBinding({
    tag: "AWS.ElastiCache.DeleteServerlessCacheSnapshot",
    operation: elasticache.deleteServerlessCacheSnapshot,
    actions: ["elasticache:DeleteServerlessCacheSnapshot"],
    // Snapshot names are runtime data.
    resources: [SERVERLESS_SNAPSHOT_ARN_WILDCARD],
  }),
);
