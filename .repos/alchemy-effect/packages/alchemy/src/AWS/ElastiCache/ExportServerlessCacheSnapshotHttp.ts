import * as elasticache from "@distilled.cloud/aws/elasticache";
import * as Layer from "effect/Layer";
import {
  makeElastiCacheAccountHttpBinding,
  SERVERLESS_SNAPSHOT_ARN_WILDCARD,
} from "./BindingHttp.ts";
import { ExportServerlessCacheSnapshot } from "./ExportServerlessCacheSnapshot.ts";

export const ExportServerlessCacheSnapshotHttp = Layer.effect(
  ExportServerlessCacheSnapshot,
  makeElastiCacheAccountHttpBinding({
    tag: "AWS.ElastiCache.ExportServerlessCacheSnapshot",
    operation: elasticache.exportServerlessCacheSnapshot,
    actions: ["elasticache:ExportServerlessCacheSnapshot"],
    // Snapshot names are runtime data. S3 access is granted to the
    // ElastiCache service via the target bucket's policy, not to the caller.
    resources: [SERVERLESS_SNAPSHOT_ARN_WILDCARD],
  }),
);
