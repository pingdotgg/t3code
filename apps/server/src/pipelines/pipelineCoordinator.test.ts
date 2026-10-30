import { assert, describe, it } from "@effect/vitest";
import { PipelineRunId, PipelineStepId } from "@t3tools/contracts";

import { pipelineCoordinatorNote } from "./pipelineCoordinator.ts";

const runId = PipelineRunId.make("pipeline-run:coordinator");
const parent = { runId, stepId: null } as const;
const turn = (runAttemptId: string, status: string, providerThreadId = "provider-thread") => ({
  providerThreadId,
  runAttemptId,
  status,
});
const note = (overrides: Partial<Parameters<typeof pipelineCoordinatorNote>[0]> = {}) =>
  pipelineCoordinatorNote({
    pipeline: parent,
    nativeCommand: false,
    providerThreadId: "provider-thread",
    activeAttemptId: "attempt-2",
    providerTurns: [],
    ...overrides,
  });

describe("pipelineCoordinatorNote", () => {
  it("sends the run's instructions on the provider thread's first turn", () => {
    assert.include(note(), `\`${runId}\``);
    // A failed or interrupted earlier turn never delivered them.
    assert.include(note({ providerTurns: [turn("attempt-1", "failed")] }), `\`${runId}\``);
    // The turn being started is not "earlier".
    assert.include(note({ providerTurns: [turn("attempt-2", "running")] }), `\`${runId}\``);
  });

  it("sends them once per provider thread", () => {
    assert.equal(note({ providerTurns: [turn("attempt-1", "completed")] }), "");
    assert.equal(note({ providerTurns: [turn("attempt-1", "running")] }), "");
    assert.include(
      note({ providerTurns: [turn("attempt-1", "completed", "other-provider-thread")] }),
      `\`${runId}\``,
    );
  });

  it("stays off native commands, step threads and plain threads", () => {
    assert.equal(note({ nativeCommand: true }), "");
    assert.equal(note({ pipeline: { runId, stepId: PipelineStepId.make("implement") } }), "");
    assert.equal(note({ pipeline: undefined }), "");
  });
});
