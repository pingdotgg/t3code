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

  it.effect(
    "omits undefined config keys so retries-only steps keep the engine timeout default",
    () =>
      Effect.gen(function* () {
        const doCalls: Array<unknown> = [];
        const step = wrapWorkflowStep({
          do: (...args: unknown[]) => {
            doCalls.push(args);
            return Promise.resolve("done");
          },
          sleep: () => Promise.resolve(),
          sleepUntil: () => Promise.resolve(),
          waitForEvent: () => Promise.resolve(),
        });

        yield* step.do({
          name: "retries-only",
          effect: Effect.succeed("done"),
          retries: { limit: 3, delay: "10 seconds", backoff: "exponential" },
        });

        expect(doCalls).toHaveLength(1);
        const config = (doCalls[0] as Array<unknown>)[1];
        expect(config).toEqual({
          retries: {
            limit: 3,
            delay: "10 seconds",
            backoff: "exponential",
          },
        });
        expect("timeout" in (config as object)).toBe(false);
      }),
  );
});
