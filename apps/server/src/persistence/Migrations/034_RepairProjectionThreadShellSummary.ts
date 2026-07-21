import * as Effect from "effect/Effect";

import Migration0023 from "./023_ProjectionThreadShellSummary.ts";
import Migration0024 from "./024_BackfillProjectionThreadShellSummary.ts";
import Migration0025 from "./025_CleanupInvalidProjectionPendingApprovals.ts";

export default Effect.gen(function* () {
  yield* Migration0023;
  yield* Migration0024;
  yield* Migration0025;
});
