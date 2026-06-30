import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { StepExecutor } from "../Services/StepExecutor.ts";
import { makeStubStepExecutor } from "./StubStepExecutor.ts";

const layer = it.layer(makeStubStepExecutor({ default: { _tag: "completed" } }));

layer("StubStepExecutor", (it) => {
  it.effect("returns the scripted default outcome", () =>
    Effect.gen(function* () {
      const executor = yield* StepExecutor;
      const outcome = yield* executor.execute({
        ticketId: "t-1" as never,
        boardId: "b-1" as never,
        pipelineRunId: "pr-1" as never,
        stepRunId: "sr-1" as never,
        laneEntryToken: "tok-1" as never,
        laneKey: "lane-1" as never,
        laneStepKeys: ["code"] as never,
        step: {
          key: "code" as never,
          type: "agent",
          agent: { instance: "claude_main", model: "sonnet" },
          instruction: "x",
        },
      });
      assert.equal(outcome._tag, "completed");
    }),
  );
});
