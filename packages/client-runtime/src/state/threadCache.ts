import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { safeErrorLogAttributes } from "../errors/safeLog.ts";
import { EnvironmentCacheStore } from "../platform/persistence.ts";

export const evictCachedThread = Effect.fn("EnvironmentThreadCache.evict")(function* (
  cache: EnvironmentCacheStore["Service"],
  environmentId: EnvironmentId,
  threadId: ThreadId,
) {
  yield* cache.removeThread(environmentId, threadId).pipe(
    Effect.catch((error) =>
      Effect.logWarning("Could not evict cached thread detail.").pipe(
        Effect.annotateLogs({
          environmentId,
          threadId,
          ...safeErrorLogAttributes(error),
        }),
      ),
    ),
  );
});
