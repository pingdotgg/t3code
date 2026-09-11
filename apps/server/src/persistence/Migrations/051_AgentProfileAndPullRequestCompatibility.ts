import * as Effect from "effect/Effect";
import profileSnapshot from "./050_ProjectionThreadProfileSnapshot.ts";
import pullRequests from "./050_ProjectionThreadPullRequests.ts";

// Earlier agent builds used 50 for profiles; upstream now uses it for PR links.
// Both migrations are idempotent, so repair either upgrade path without losing data.
export default Effect.gen(function* () {
  yield* profileSnapshot;
  yield* pullRequests;
});
