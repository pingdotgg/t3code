import * as Effect from "effect/Effect";

import CheckpointTransitionFiles from "./113_ProjectionCheckpointTransitionFiles.ts";
import ThreadContext from "./113_ProjectionThreadContext.ts";

// Main and the earlier context branch both published migration 113. An install can
// therefore have either schema at that high-water mark. Both effects check column
// existence, so an appended repair safely completes either history without rewriting it.
export default Effect.gen(function* () {
  yield* CheckpointTransitionFiles;
  yield* ThreadContext;
});
