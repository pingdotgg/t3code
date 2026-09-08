import * as Alchemy from "@/index.ts";
import { Stack } from "@/Stack";
import { InMemoryService, State, type ResourceState } from "@/State";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { TestLayers, TestResource } from "./test.resources.ts";

// Regression coverage for https://github.com/alchemy-run/alchemy/issues/961:
// destroying a stack used to re-persist an empty `{}` output record for the
// stage. `state.getOutput` then returned a non-null, field-less husk while
// `state stages` no longer reported the stage, and cross-stack
// `Output.stackRef` consumers crashed reading fields off the husk at plan
// time. After destroy, the persisted output record must be gone entirely.

const { test } = Test.make({ providers: TestLayers() });

describe("destroy clears the persisted stack output", () => {
  test.provider("scratch stack destroy removes the output record", (stack) =>
    Effect.gen(function* () {
      const state = yield* yield* State;
      const stk = yield* Stack;

      const deployed = yield* Effect.gen(function* () {
        const A = yield* TestResource("A", { string: "test-string" });
        return { url: A.string };
      }).pipe(stack.deploy);
      expect(deployed).toEqual({ url: "test-string" });

      expect(
        yield* state.getOutput({ stack: stk.name, stage: stk.stage }),
      ).toEqual({ url: "test-string" });

      yield* stack.destroy();

      // The output record must be removed, not overwritten with `{}`.
      expect(
        yield* state.getOutput({ stack: stk.name, stage: stk.stage }),
      ).toBeUndefined();
      // ... and `listStages` must agree the stage is gone.
      expect(yield* state.listStages(stk.name)).not.toContain(stk.stage);
    }),
  );
});

// The same regression through the real `deploy`/`destroy` entry points
// (`Destroy.ts`), which is what `alchemy destroy` and the test harness's
// `destroy(Stack)` run.
const store: Record<string, Record<string, Record<string, ResourceState>>> = {};
const outputs: Record<string, Record<string, unknown>> = {};
const stateLayer = Layer.succeed(State, InMemoryService(store, outputs));

const harness = Test.make({ providers: TestLayers(), state: stateLayer });

const DestroyOutputStack = Alchemy.Stack(
  "DestroyOutputStack",
  { providers: TestLayers(), state: stateLayer },
  Effect.gen(function* () {
    const A = yield* TestResource("A", { string: "test-string" });
    return { url: A.string };
  }),
);

harness.test(
  "stack destroy removes the persisted stack output",
  Effect.gen(function* () {
    yield* harness.deploy(DestroyOutputStack);
    expect(outputs.DestroyOutputStack?.test).toEqual({ url: "test-string" });

    yield* harness.destroy(DestroyOutputStack);
    expect(outputs.DestroyOutputStack?.test).toBeUndefined();
    expect(store.DestroyOutputStack?.test).toBeUndefined();
  }),
);
