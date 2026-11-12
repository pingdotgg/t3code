import { describe, expect, it } from "@effect/vitest";
import { TailscaleCommandExitError, type TailscaleCommandError } from "@t3tools/tailscale";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import { retryTailscaleServe } from "./tailscaleServeStartup.ts";

const exitError = (stderrDiagnostic: "not-running" | "permission-denied") =>
  new TailscaleCommandExitError({
    executable: "tailscale",
    subcommand: "serve",
    argumentCount: 4,
    exitCode: 1,
    stderrLength: 10,
    stderrDiagnostic,
  });

describe("retryTailscaleServe", () => {
  it.effect("keeps retrying until Serve succeeds and reports each new failure kind once", () =>
    Effect.gen(function* () {
      const failures: ReadonlyArray<TailscaleCommandError> = [
        exitError("not-running"),
        exitError("not-running"),
        exitError("permission-denied"),
        exitError("permission-denied"),
      ];
      let attempts = 0;
      const reported: Array<string | undefined> = [];
      const fiber = yield* retryTailscaleServe(
        Effect.suspend(() => {
          const failure = failures[attempts];
          attempts += 1;
          return failure === undefined ? Effect.void : Effect.fail(failure);
        }),
        (error) =>
          Effect.sync(() => {
            reported.push(
              error._tag === "TailscaleCommandExitError" ? error.stderrDiagnostic : error._tag,
            );
          }),
      ).pipe(Effect.forkChild);
      yield* TestClock.adjust("10 minutes");
      yield* Fiber.join(fiber);
      expect(attempts).toBe(5);
      expect(reported).toEqual(["not-running", "permission-denied"]);
    }),
  );
});
