import * as elasticache from "@distilled.cloud/aws/elasticache";
import * as Layer from "effect/Layer";
import {
  makeElastiCacheAccountHttpBinding,
  SERVERLESS_SNAPSHOT_ARN_WILDCARD,
} from "./BindingHttp.ts";
import { CopyServerlessCacheSnapshot } from "./CopyServerlessCacheSnapshot.ts";

export const CopyServerlessCacheSnapshotHttp = Layer.effect(
  CopyServerlessCacheSnapshot,
  makeElastiCacheAccountHttpBinding({
    tag: "AWS.ElastiCache.CopyServerlessCacheSnapshot",
    operation: elasticache.copyServerlessCacheSnapshot,
    // AddTagsToResource authorizes tag-on-create for the target snapshot.
    actions: [
      "elasticache:CopyServerlessCacheSnapshot",
      "elasticache:AddTagsToResource",
    ],
    // The action authorizes against both the source and target snapshots,
    // whose names are runtime data.
    resources: [SERVERLESS_SNAPSHOT_ARN_WILDCARD],
  }),
);
