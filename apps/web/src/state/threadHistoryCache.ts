import { ThreadHistoryCacheStore } from "@t3tools/client-runtime/platform";
import { createRuntimeCommand } from "@t3tools/client-runtime/state/runtime";
import * as Effect from "effect/Effect";

import { connectionAtomRuntime } from "../connection/runtime";

export const clearLocalThreadHistoryCache = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:thread-history:clear-local-cache",
  concurrency: { mode: "singleFlight", key: () => "global" },
  execute: () =>
    ThreadHistoryCacheStore.pipe(Effect.flatMap((historyCache) => historyCache.clearAll())),
});
