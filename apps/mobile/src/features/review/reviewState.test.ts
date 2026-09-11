import { afterEach, assert, it } from "vite-plus/test";

import { appAtomRegistry } from "../../state/atom-registry";
import { getCachedNativeReviewDiffData } from "./nativeReviewDiffAdapter";
import {
  getCachedReviewParsedDiff,
  getReviewAsyncStateSnapshot,
  setReviewAsyncError,
  setReviewTurnDiffLoading,
} from "./reviewState";

const reviewInput = {
  threadKey: "env-local:thread-review",
  sectionId: "turn:1",
  diff: [
    "diff --git a/src/a.ts b/src/a.ts",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/src/a.ts",
    "@@ -0,0 +1 @@",
    "+export const value = 1;",
  ].join("\n"),
};

afterEach(() => {
  appAtomRegistry.reset();
});

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

it("reuses unchanged parsed diffs and replaces changed sections", () => {
  const parsed = getCachedReviewParsedDiff(reviewInput);

  assert.strictEqual(
    getCachedReviewParsedDiff({ ...reviewInput, diff: `\n${reviewInput.diff}\n` }),
    parsed,
  );

  const changed = { ...reviewInput, diff: reviewInput.diff.replace("value = 1", "value = 2") };
  const updated = getCachedReviewParsedDiff(changed);
  assert.notStrictEqual(updated, parsed);
  assert.strictEqual(getCachedReviewParsedDiff(changed), updated);
});

it("evicts the least recently used section across threads without changing live results or IDs", () => {
  const recentInput = { ...reviewInput, threadKey: "env-local:thread-recent" };
  const oldestInput = { ...reviewInput, threadKey: "env-remote:thread-oldest" };
  const recent = getCachedReviewParsedDiff(recentInput);
  const oldest = getCachedReviewParsedDiff(oldestInput);
  const native = getCachedNativeReviewDiffData({ parsedDiff: oldest });
  for (let index = 0; index < 6; index += 1) {
    getCachedReviewParsedDiff({ ...reviewInput, threadKey: `env-local:thread-${index}` });
  }

  assert.strictEqual(getCachedReviewParsedDiff(recentInput), recent);
  getCachedReviewParsedDiff({ ...reviewInput, threadKey: "env-local:thread-new" });

  assert.strictEqual(getCachedReviewParsedDiff(recentInput), recent);
  const rebuilt = getCachedReviewParsedDiff(oldestInput);
  assert.notStrictEqual(rebuilt, oldest);
  assert.deepStrictEqual(rebuilt, oldest);
  assert.strictEqual(getCachedNativeReviewDiffData({ parsedDiff: oldest }), native);
  assert.deepStrictEqual(getCachedNativeReviewDiffData({ parsedDiff: rebuilt }), native);
});

it("limits cached diffs to 4 Mi source characters before the entry limit", () => {
  const firstInput = { ...reviewInput, diff: "x".repeat(2 * 1024 * 1024) };
  const secondInput = { ...firstInput, sectionId: "turn:2" };
  const first = getCachedReviewParsedDiff(firstInput);
  const second = getCachedReviewParsedDiff(secondInput);

  getCachedReviewParsedDiff({ ...firstInput, sectionId: "turn:3" });

  assert.strictEqual(getCachedReviewParsedDiff(secondInput), second);
  assert.notStrictEqual(getCachedReviewParsedDiff(firstInput), first);
});

it("reclaims the source budget when a cached section changes", () => {
  const firstInput = { ...reviewInput, diff: "x".repeat(2 * 1024 * 1024) };
  const secondInput = { ...firstInput, sectionId: "turn:2" };
  getCachedReviewParsedDiff(firstInput);
  const second = getCachedReviewParsedDiff(secondInput);

  getCachedReviewParsedDiff({ ...firstInput, diff: null });
  getCachedReviewParsedDiff({ ...firstInput, sectionId: "turn:3" });

  assert.strictEqual(getCachedReviewParsedDiff(secondInput), second);
});

it("counts the full source and skips oversized diffs without evicting cached sections", () => {
  const cached = getCachedReviewParsedDiff(reviewInput);
  const oversizedInput = {
    ...reviewInput,
    sectionId: "turn:oversized",
    diff: `${reviewInput.diff}${" ".repeat(4 * 1024 * 1024)}`,
  };
  const first = getCachedReviewParsedDiff(oversizedInput);
  const second = getCachedReviewParsedDiff(oversizedInput);

  assert.notStrictEqual(second, first);
  assert.deepStrictEqual(second, first);
  assert.strictEqual(getCachedReviewParsedDiff(reviewInput), cached);
});

it("drops parsed diffs when the app registry resets", () => {
  const parsed = getCachedReviewParsedDiff(reviewInput);

  appAtomRegistry.reset();

  const rebuilt = getCachedReviewParsedDiff(reviewInput);
  assert.notStrictEqual(rebuilt, parsed);
  assert.deepStrictEqual(rebuilt, parsed);
});
