import { EnvironmentId, MessageId, RunId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { resumeThread } from "./resume-thread";

const runId = RunId.make("run-limited");
const failure = AsyncResult.failure(Cause.fail(new Error("not connected")));

function setup(options: { readonly startTurnFails?: boolean } = {}) {
  const calls: Array<{ readonly command: string; readonly input: unknown }> = [];
  const record =
    (command: string, fails = false) =>
    async (request: { readonly input: unknown }) => {
      calls.push({ command, input: request.input });
      return fails ? failure : AsyncResult.success(undefined);
    };
  const base = {
    thread: {
      environmentId: EnvironmentId.make("env"),
      id: ThreadId.make("thread"),
      runtimeMode: "full-access",
      interactionMode: "default",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    modelSelection: null,
    messageId: MessageId.make("message"),
    createdAt: "2026-10-30T00:00:00.000Z",
    setRuntimeMode: record("setRuntimeMode"),
    setInteractionMode: record("setInteractionMode"),
    startTurn: record("startTurn", options.startTurnFails),
    resumeQueue: record("resumeQueue"),
  } as const;
  return { calls, base };
}

describe("resumeThread", () => {
  it("continues the limited run before resuming its held queue", async () => {
    const { calls, base } = setup();
    const result = await resumeThread({ ...base, resumableRunId: runId, queueHeld: true });

    expect(result._tag).toBe("Success");
    expect(calls.map((call) => call.command)).toEqual(["startTurn", "resumeQueue"]);
    expect(calls[0]?.input).toMatchObject({
      manualContinuationOfRunId: runId,
      dispatchMode: "start",
    });
  });

  it("does not resume the queue when the continuation fails", async () => {
    const { calls, base } = setup({ startTurnFails: true });
    const result = await resumeThread({ ...base, resumableRunId: runId, queueHeld: true });

    expect(result).toBe(failure);
    expect(calls.map((call) => call.command)).toEqual(["startTurn"]);
  });

  it("only continues the run when nothing is queued", async () => {
    const { calls, base } = setup();
    await resumeThread({ ...base, resumableRunId: runId, queueHeld: false });

    expect(calls.map((call) => call.command)).toEqual(["startTurn"]);
  });

  it("saves changed modes to the thread before continuing", async () => {
    const { calls, base } = setup();
    await resumeThread({
      ...base,
      runtimeMode: "approval-required",
      interactionMode: "plan",
      resumableRunId: runId,
      queueHeld: false,
    });

    expect(calls.map((call) => call.command)).toEqual([
      "setRuntimeMode",
      "setInteractionMode",
      "startTurn",
    ]);
  });

  it("resumes a held queue directly when no run needs continuing", async () => {
    const { calls, base } = setup();
    await resumeThread({ ...base, resumableRunId: null, queueHeld: true });

    expect(calls.map((call) => call.command)).toEqual(["resumeQueue"]);
  });
});
