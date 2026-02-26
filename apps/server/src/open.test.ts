import { assert, describe, it } from "@effect/vitest";

import { launchDetached, resolveEditorLaunch } from "./open";
import { Effect } from "effect";
import { assertSuccess } from "@effect/vitest/utils";

describe("resolveEditorLaunch", () => {
  it.effect("returns cursor command for cursor editor", () =>
    Effect.gen(function* () {
      const launch = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "cursor" },
        "darwin",
      );
      assert.deepEqual(launch, {
        command: "cursor",
        args: ["/tmp/workspace"],
      });
    }),
  );

  it.effect("maps file-manager editor to OS open commands", () =>
    Effect.gen(function* () {
      const launch1 = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "file-manager" },
        "darwin",
      );
      assert.deepEqual(launch1, {
        command: "open",
        args: ["/tmp/workspace"],
      });

      const launch2 = yield* resolveEditorLaunch(
        { cwd: "C:\\workspace", editor: "file-manager" },
        "win32",
      );
      assert.deepEqual(launch2, {
        command: "explorer",
        args: ["C:\\workspace"],
      });

      const launch3 = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "file-manager" },
        "linux",
      );
      assert.deepEqual(launch3, {
        command: "xdg-open",
        args: ["/tmp/workspace"],
      });
    }),
  );
});

describe("launchDetached", () => {
  it.effect("resolves when command can be spawned", () =>
    Effect.gen(function* () {
      const result = yield* launchDetached({
        command: process.execPath,
        args: ["-e", "process.exit(0)"],
      }).pipe(Effect.result);
      assertSuccess(result, undefined);
    }),
  );

  it.effect("rejects when command does not exist", () =>
    Effect.gen(function* () {
      const result = yield* launchDetached({
        command: `t3code-no-such-command-${Date.now()}`,
        args: [],
      }).pipe(Effect.result);
      assert.equal(result._tag, "Failure");
    }),
  );
});
