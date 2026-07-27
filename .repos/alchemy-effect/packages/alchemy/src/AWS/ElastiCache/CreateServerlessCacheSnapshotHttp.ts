import * as elasticache from "@distilled.cloud/aws/elasticache";
import * as Layer from "effect/Layer";
import {
  makeElastiCacheCacheHttpBinding,
  SERVERLESS_SNAPSHOT_ARN_WILDCARD,
} from "./BindingHttp.ts";
import { CreateServerlessCacheSnapshot } from "./CreateServerlessCacheSnapshot.ts";

export const CreateServerlessCacheSnapshotHttp = Layer.effect(
  CreateServerlessCacheSnapshot,
  makeElastiCacheCacheHttpBinding({
    tag: "AWS.ElastiCache.CreateServerlessCacheSnapshot",
    operation: elasticache.createServerlessCacheSnapshot,
    // AddTagsToResource authorizes tag-on-create for the snapshot.
    actions: [
      "elasticache:CreateServerlessCacheSnapshot",
      "elasticache:AddTagsToResource",
    ],
    // The action authorizes against both the source cache and the
    // to-be-created snapshot (whose name-based ARN is runtime data).
    extraResources: [SERVERLESS_SNAPSHOT_ARN_WILDCARD],
  }),
);
