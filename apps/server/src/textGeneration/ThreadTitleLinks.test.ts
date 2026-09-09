import { expect, it } from "@effect/vitest";
import { ExitCode } from "effect/unstable/process/ChildProcessSpawner";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import * as Fiber from "effect/Fiber";
import * as Deferred from "effect/Deferred";
import { resolveThreadTitleLinks } from "./ThreadTitleLinks.ts";
import * as ProcessRunner from "../processRunner.ts";

const success: ProcessRunner.ProcessRunOutput = {
  stdout: JSON.stringify({
    title: "Fix QR pairing expiry",
    body: "Keep remote connections working.",
  }),
  stderr: "",
  code: ExitCode(0),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
};

it.effect("reads explicit GitHub subjects once with bounded output", () =>
  Effect.gen(function* () {
    const calls: ProcessRunner.ProcessRunInput[] = [];
    const result = yield* resolveThreadTitleLinks({
      cwd: "/tmp/project",
      message:
        "Review https://github.com/pingdotgg/t3code/pull/123 and https://github.com/pingdotgg/t3code/pull/123. Ignore https://github.com.evil.test/a/b/issues/1",
    }).pipe(
      Effect.provideService(ProcessRunner.ProcessRunner, {
        run: (input) => {
          calls.push(input);
          return Effect.succeed(success);
        },
      }),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual([
      "api",
      "repos/pingdotgg/t3code/issues/123",
      "--jq",
      "{title, body}",
    ]);
    expect(result).toContain("Fix QR pairing expiry");
  }),
);

it.effect("returns unavailable when a lookup times out", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const fiber = yield* resolveThreadTitleLinks({
      cwd: "/tmp/project",
      message: "Fix https://github.com/pingdotgg/t3code/issues/123",
    }).pipe(
      Effect.provideService(ProcessRunner.ProcessRunner, {
        run: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
      }),
      Effect.forkChild,
    );
    yield* Deferred.await(started);
    yield* TestClock.adjust("3 seconds");
    expect(yield* Fiber.join(fiber)).toBe(
      "https://github.com/pingdotgg/t3code/issues/123: unavailable",
    );
  }),
);

it.effect("keeps lookup failure out of generation and skips unlinked messages", () =>
  Effect.gen(function* () {
    expect(yield* resolveThreadTitleLinks({ cwd: "/tmp", message: "Fix pairing" })).toBeUndefined();
    expect(
      yield* resolveThreadTitleLinks({
        cwd: "/tmp",
        message: "https://github.com/pingdotgg/t3code/issues/1",
      }),
    ).toContain("unavailable");
  }).pipe(
    Effect.provideService(ProcessRunner.ProcessRunner, {
      run: () => Effect.succeed({ ...success, code: ExitCode(1), stdout: "" }),
    }),
  ),
);
