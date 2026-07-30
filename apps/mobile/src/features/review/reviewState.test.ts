import { assert, it } from "vite-plus/test";

import {
  getReviewAsyncStateSnapshot,
  setReviewAsyncError,
  setReviewTurnDiffLoading,
} from "./reviewState";

it("stores review async loading and error state in atoms", () => {
  const threadKey = `env-local:thread-review-state-${Date.now()}`;

  setReviewTurnDiffLoading(threadKey, "turn-1", true);
  setReviewAsyncError(threadKey, "load failed");

  assert.deepStrictEqual(getReviewAsyncStateSnapshot(threadKey), {
    loadingTurnIds: { "turn-1": true },
    error: "load failed",
  });

  setReviewTurnDiffLoading(threadKey, "turn-1", false);
  setReviewAsyncError(threadKey, null);

  assert.deepStrictEqual(getReviewAsyncStateSnapshot(threadKey), {
    loadingTurnIds: {},
    error: null,
  });
});
