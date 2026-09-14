import { describe, it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/unstable/process";
import { requestTerminalPermission } from "./terminalPermissions.ts";

function permissionSpawner(exitCode: Effect.Effect<ChildProcessSpawner.ExitCode>, stderr = "") {
  return ChildProcessSpawner.make(() =>
    Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode,
        isRunning: Effect.succeed(true),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.empty,
        stderr: Stream.make(new TextEncoder().encode(stderr)),
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      }),
    ),
  );
}

const exit = (code: number) => Effect.succeed(ChildProcessSpawner.ExitCode(code));

describe("terminal permissions", () => {
  for (const terminal of ["system", "terminal", "iterm2"] as const) {
    it.effect(`waits for ${terminal} permission to succeed`, () =>
      requestTerminalPermission(terminal, "darwin").pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, permissionSpawner(exit(0))),
      ),
    );
  }

  it.effect("does not ask for Automation permission for Ghostty or non-macOS terminals", () =>
    Effect.all([
      requestTerminalPermission("ghostty", "darwin"),
      requestTerminalPermission("system", "win32"),
      requestTerminalPermission("iterm2", "linux"),
    ]).pipe(
      Effect.provideService(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() => Effect.die("Unexpected permission prompt")),
      ),
    ),
  );

  it.effect("reports denied access with a recovery path", () =>
    Effect.gen(function* () {
      const error = yield* requestTerminalPermission("terminal", "darwin").pipe(
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          permissionSpawner(exit(1), "Not authorized to send Apple events. (-1743)"),
        ),
        Effect.flip,
      );
      expect(error.reason).toBe("denied");
      expect(error.message).toContain("Privacy & Security → Automation");
    }),
  );

  it.effect("reports a missing application without treating it as denied consent", () =>
    Effect.gen(function* () {
      const error = yield* requestTerminalPermission("iterm2", "darwin").pipe(
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          permissionSpawner(exit(1), "Application not found"),
        ),
        Effect.flip,
      );
      expect(error.reason).toBe("unavailable");
    }),
  );

  it.effect("allows more than thirty seconds to answer the first permission prompt", () =>
    Effect.gen(function* () {
      const fiber = yield* requestTerminalPermission("terminal", "darwin").pipe(
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          permissionSpawner(Effect.delay(exit(0), "45 seconds")),
        ),
        Effect.forkChild,
      );
      yield* TestClock.adjust("45 seconds");
      yield* Fiber.join(fiber);
    }),
  );

  it.effect("returns actionable guidance when a permission prompt times out", () =>
    Effect.gen(function* () {
      const fiber = yield* requestTerminalPermission("terminal", "darwin").pipe(
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          permissionSpawner(Effect.never),
        ),
        Effect.flip,
        Effect.forkChild,
      );
      yield* TestClock.adjust("2 minutes");
      const error = yield* Fiber.join(fiber);
      expect(error.reason).toBe("timeout");
    }),
  );
});
