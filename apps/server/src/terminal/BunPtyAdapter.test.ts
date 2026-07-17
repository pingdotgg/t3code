import { assert, expect, it } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import * as BunPtyAdapter from "./BunPtyAdapter.ts";

it("describes unavailable Bun PTY operations structurally", () => {
  const error = new BunPtyAdapter.BunPtyOperationUnavailableError({
    operation: "resize",
    pid: 42,
  });

  expect(error).toMatchObject({
    _tag: "BunPtyOperationUnavailableError",
    operation: "resize",
    pid: 42,
  });
  expect(error.message).toBe("Bun PTY resize is unavailable for process 42.");
});

it.effect("reports unsupported platforms with a structured startup defect", () =>
  Effect.gen(function* () {
    const exit = yield* BunPtyAdapter.make().pipe(
      Effect.provideService(HostProcessPlatform, "win32"),
      Effect.exit,
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.hasDies(exit.cause)).toBe(true);
      const error = Cause.squash(exit.cause);
      assert.instanceOf(error, BunPtyAdapter.BunPtyUnsupportedPlatformError);
      expect(error).toMatchObject({
        _tag: "BunPtyUnsupportedPlatformError",
        platform: "win32",
      });
      expect(error.message).toBe(
        "Bun PTY terminal support is unavailable on win32. Please use Node.js (e.g. by running `npx t3`) instead.",
      );
    }
  }),
);
