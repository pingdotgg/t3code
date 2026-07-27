import { wrapWorkflowStep } from "@/Cloudflare/Workflows/WorkflowBridge.ts";
import { describe, expect, it } from "alchemy-test";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

describe("WorkflowBridge", () => {
  it.effect("preserves native Workflow control-flow rejections", () =>
    Effect.gen(function* () {
      const controlError = new Error("Aborting engine: User called pause");
      const rejectWithControlError = () =>
        Effect.runPromise(Effect.die(controlError));
      const step = wrapWorkflowStep({
        do: rejectWithControlError,
        sleep: rejectWithControlError,
        sleepUntil: rejectWithControlError,
        waitForEvent: rejectWithControlError,
      });

      const effects = [
        step.do({ name: "task", effect: Effect.succeed("done") }),
        step.sleep("sleep", "1 second"),
        step.sleepUntil("sleep-until", 1),
        step.waitForEvent("event", { type: "test-event" }),
      ];

      for (const effect of effects) {
        const exit = yield* Effect.exit(effect);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(Cause.squash(exit.cause)).toBe(controlError);
        }
      }
    }),
  );
});
