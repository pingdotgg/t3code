import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { assert, describe } from "vite-plus/test";

import { makeWorktreeBootstrapLocks } from "./worktreeBootstrapLock.ts";

// The critical sections yield in the middle, so an unlocked run would
// interleave them: the recorded order is what proves the permit holds.
const criticalSection = (trace: Array<string>, label: string) =>
  Effect.gen(function* () {
    trace.push(`enter:${label}`);
    yield* Effect.yieldNow;
    trace.push(`exit:${label}`);
  });

describe("makeWorktreeBootstrapLocks", () => {
  it.effect("runs preparations for one repository one at a time", () =>
    Effect.gen(function* () {
      const withLock = makeWorktreeBootstrapLocks();
      const trace: Array<string> = [];

      yield* Effect.forEach(
        ["a", "b", "c"],
        (label) => withLock("/repo", criticalSection(trace, label)),
        { concurrency: "unbounded" },
      );

      assert.deepEqual(trace, ["enter:a", "exit:a", "enter:b", "exit:b", "enter:c", "exit:c"]);
    }),
  );

  it.effect("lets independent repositories prepare at the same time", () =>
    Effect.gen(function* () {
      const withLock = makeWorktreeBootstrapLocks();
      const trace: Array<string> = [];

      yield* Effect.forEach(
        [
          { cwd: "/repo-a", label: "a" },
          { cwd: "/repo-b", label: "b" },
        ],
        ({ cwd, label }) => withLock(cwd, criticalSection(trace, label)),
        { concurrency: "unbounded" },
      );

      assert.deepEqual(trace, ["enter:a", "enter:b", "exit:a", "exit:b"]);
    }),
  );

  it.effect("releases the permit when a preparation fails", () =>
    Effect.gen(function* () {
      const withLock = makeWorktreeBootstrapLocks();
      const trace: Array<string> = [];

      const failed = yield* Effect.exit(withLock("/repo", Effect.fail("worktree add failed")));
      assert.equal(failed._tag, "Failure");

      yield* withLock("/repo", criticalSection(trace, "next"));
      assert.deepEqual(trace, ["enter:next", "exit:next"]);
    }),
  );
});
