import { assert, describe, it } from "@effect/vitest";
import {
  normalizeClaudeTaskStatus,
  taskUsageFields,
  syntheticCompletionFromTaskPatch,
  terminalStatusFromTaskPatch,
} from "./claudeTaskFrames.ts";

describe("normalizeClaudeTaskStatus", () => {
  it("passes the three declared statuses through", () => {
    assert.equal(normalizeClaudeTaskStatus("completed"), "completed");
    assert.equal(normalizeClaudeTaskStatus("failed"), "failed");
    assert.equal(normalizeClaudeTaskStatus("stopped"), "stopped");
  });

  it("unknown status is failed, never done", () => {
    for (const raw of ["succeeded", "", "running", undefined, null, {}, 3]) {
      assert.equal(normalizeClaudeTaskStatus(raw), "failed");
    }
  });
});

describe("terminalStatusFromTaskPatch", () => {
  it("maps terminal patch statuses", () => {
    assert.equal(terminalStatusFromTaskPatch({ status: "completed" }), "completed");
    assert.equal(terminalStatusFromTaskPatch({ status: "failed" }), "failed");
    assert.equal(terminalStatusFromTaskPatch({ status: "killed" }), "failed");
  });

  it("returns null for non-terminal patch statuses", () => {
    assert.equal(terminalStatusFromTaskPatch({ status: "pending" }), null);
    assert.equal(terminalStatusFromTaskPatch({ status: "running" }), null);
    assert.equal(terminalStatusFromTaskPatch({ status: "paused" }), null);
    assert.equal(terminalStatusFromTaskPatch({}), null);
    assert.equal(terminalStatusFromTaskPatch({ error: "boom" }), null);
  });
});

describe("taskUsageFields", () => {
  it("returns an empty object when usage is absent", () => {
    assert.deepStrictEqual(taskUsageFields(undefined), {});
  });

  it("keeps only the present keys", () => {
    assert.deepStrictEqual(taskUsageFields({ tool_uses: 4 }), { toolUses: 4 });
    assert.deepStrictEqual(taskUsageFields({ total_tokens: 12, tool_uses: 1, duration_ms: 900 }), {
      totalTokens: 12,
      toolUses: 1,
      durationMs: 900,
    });
  });

  it("drops nonsensical numbers rather than persisting them", () => {
    assert.deepStrictEqual(
      taskUsageFields({ total_tokens: -1, tool_uses: 1.5, duration_ms: Number.NaN }),
      {},
    );
  });
});

// fork: f3 — only `killed` may be synthesized; the others get their own
// `task_notification`, and synthesizing them persisted a duplicate activity.
describe("syntheticCompletionFromTaskPatch", () => {
  it("synthesizes only for killed, the one status with no notification", () => {
    assert.equal(syntheticCompletionFromTaskPatch({ status: "killed" }), "failed");
    assert.equal(syntheticCompletionFromTaskPatch({ status: "completed" }), null);
    assert.equal(syntheticCompletionFromTaskPatch({ status: "failed" }), null);
    assert.equal(syntheticCompletionFromTaskPatch({ status: "running" }), null);
    assert.equal(syntheticCompletionFromTaskPatch({}), null);
  });
});
