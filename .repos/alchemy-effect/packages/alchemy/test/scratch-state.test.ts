import { State } from "@/State";
import * as Test from "@/Test/Alchemy";
import * as Core from "@/Test/Core";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { TestLayers, TestResource } from "./test.resources.ts";

const { test } = Test.make({ providers: TestLayers() });

// `test.provider` scratch state must be DURABLE (disk-backed) when the
// adapter can namespace it by test file. A run killed while a provider
// delete is still in flight (the runner abandons teardown 10s after a test
// timeout) leaves its `deleting` rows behind; the next run's leading
// `stack.destroy()` must see those rows and resume the delete. With the old
// in-memory scratch store the rows died with the process, the next destroy
// planned "no changes", and the cloud resource was orphaned invisibly.
//
// Cross-process durability is exercised here as cross-INSTANCE durability:
// each `Core.scratchStack` call builds a fresh store handle, so a second
// instance only sees the first instance's rows if they were persisted.
describe("test.provider scratch state durability", () => {
  const options = { providers: TestLayers() };
  const NAME = "durability-probe";
  const FILE = "test/scratch-state.test.ts";

  const listRows = (scratch: Core.ScratchStack, stackName: string) =>
    Effect.gen(function* () {
      const state = yield* yield* State;
      return yield* state.list({ stack: stackName, stage: "test" });
    }).pipe(Effect.provide(scratch.state));

  test(
    "rows persist across scratch instances and a later destroy drains them",
    Effect.gen(function* () {
      // First "run": deploy a resource, then walk away without destroying —
      // the shape of a run whose teardown was abandoned.
      const run1 = Core.scratchStack(options, NAME, FILE);
      yield* run1.deploy(
        Effect.gen(function* () {
          yield* TestResource("A", { string: "v1" });
        }),
      );

      // Second "run": a fresh scratch instance for the same (file, test)
      // must see the persisted row...
      const run2 = Core.scratchStack(options, NAME, FILE);
      expect(run2.name).toEqual(run1.name);
      expect(yield* listRows(run2, run2.name)).toEqual(["A"]);

      // ...and its destroy must reclaim it.
      yield* run2.destroy();
      const run3 = Core.scratchStack(options, NAME, FILE);
      expect(yield* listRows(run3, run3.name)).toEqual([]);
    }),
  );

  test(
    "scratch stack names are namespaced by file",
    Effect.gen(function* () {
      // Test names repeat across files ("create and delete bucket with
      // default props" exists in several suites); the durable store must
      // never collide across files or one test's destroy would delete
      // another's live cloud resources.
      const a = Core.scratchStack(options, "same name", "test/A/One.test.ts");
      const b = Core.scratchStack(options, "same name", "test/B/One.test.ts");
      expect(a.name).not.toEqual(b.name);

      // Without a file (bun/vitest adapters), the store stays in-memory and
      // the name stays the bare test name — the pre-existing behavior.
      const bare = Core.scratchStack(options, "same name");
      expect(bare.name).toEqual("same-name");
    }),
  );
});
