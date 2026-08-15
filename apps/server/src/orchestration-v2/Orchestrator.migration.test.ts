import { assert, it } from "@effect/vitest";
import { ContextHandoffId, ThreadId } from "@t3tools/contracts";

import {
  appendContextHandoffId,
  canReplayCommandReceipt,
  shouldPrepareLegacyImportHandoff,
} from "./Orchestrator.ts";

it("reissues imported context until a V2 run completes", () => {
  assert.isTrue(
    shouldPrepareLegacyImportHandoff({
      historyOrigin: "v1_import",
      hasCompletedRun: false,
      legacyImportItemCount: 2,
    }),
  );
  assert.isFalse(
    shouldPrepareLegacyImportHandoff({
      historyOrigin: "v1_import",
      hasCompletedRun: true,
      legacyImportItemCount: 2,
    }),
  );
  assert.isFalse(
    shouldPrepareLegacyImportHandoff({
      historyOrigin: undefined,
      hasCompletedRun: false,
      legacyImportItemCount: 2,
    }),
  );
  assert.isFalse(
    shouldPrepareLegacyImportHandoff({
      historyOrigin: "v1_import",
      hasCompletedRun: false,
      legacyImportItemCount: 0,
    }),
  );
});

it("records a reissued legacy handoff on an existing provider thread", () => {
  const existingHandoffId = ContextHandoffId.make("handoff:legacy-import:existing");
  const retryHandoffId = ContextHandoffId.make("handoff:legacy-import:retry");

  assert.deepEqual(appendContextHandoffId([existingHandoffId], retryHandoffId), [
    existingHandoffId,
    retryHandoffId,
  ]);
  assert.deepEqual(appendContextHandoffId([existingHandoffId], existingHandoffId), [
    existingHandoffId,
  ]);
  assert.deepEqual(appendContextHandoffId([existingHandoffId], null), [existingHandoffId]);
});

it("only replays a command receipt for the thread it was recorded against", () => {
  const threadA = ThreadId.make("thread-a");
  const threadB = ThreadId.make("thread-b");

  assert.strictEqual(canReplayCommandReceipt(threadA, threadA), true);
  // A reused command id aimed at another thread must not report the first
  // thread's success as this thread's (v1 #5246).
  assert.strictEqual(canReplayCommandReceipt(threadA, threadB), false);
});
