import * as Effect from "effect/Effect";

import ThreadColdArchive from "./035_ThreadColdArchive.ts";
import DeletedThreadCleanupQueue from "./036_DeletedThreadCleanupQueue.ts";

/**
 * Re-runs both idempotent lifecycle migrations above every upstream migration
 * ID that existed when cold storage was introduced on this branch.
 */
export default Effect.gen(function* () {
  yield* ThreadColdArchive;
  yield* DeletedThreadCleanupQueue;
});
