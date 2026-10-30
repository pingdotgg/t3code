import { expect, it } from "@effect/vitest";
import { ServerNpmReleaseError } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as TestClock from "effect/testing/TestClock";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ProcessRunner from "../processRunner.ts";
import * as NpmRelease from "./npmRelease.ts";

const version = "0.1.5-nightly.20261030.1";
const output = (stdout: string, code = 0): ProcessRunner.ProcessRunOutput => ({
  stdout,
  stderr: "",
  code: ChildProcessSpawner.ExitCode(code),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});

it.effect.each([
  {
    spec: version,
    stdout: JSON.stringify({ version, t3code: { databaseMigration: 42 } }),
    migration: 42,
  },
  {
    spec: "nightly",
    stdout: JSON.stringify([{ version, t3code: { databaseMigration: 42 } }]),
    migration: 42,
  },
  { spec: "latest", stdout: JSON.stringify({ version }), migration: undefined },
])("reads $spec through npm and retains migration compatibility metadata", (fixture) =>
  Effect.gen(function* () {
    const calls: ProcessRunner.ProcessRunInput[] = [];
    const service = yield* NpmRelease.make().pipe(
      Effect.provideService(ProcessRunner.ProcessRunner, {
        run: (input) => {
          calls.push(input);
          return Effect.succeed(output(fixture.stdout));
        },
      }),
    );
    const expected = {
      version,
      ...(fixture.migration === undefined ? {} : { databaseMigration: fixture.migration }),
    };
    expect(yield* service.get({ spec: fixture.spec })).toEqual(expected);
    expect(yield* service.get({ spec: fixture.spec })).toEqual(expected);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      command: "npm",
      args: ["view", "--global", "--json", `t3@${fixture.spec}`],
      maxOutputBytes: 256 * 1024,
    });
    yield* TestClock.adjust("1 minute");
    expect(yield* service.get({ spec: fixture.spec })).toEqual(expected);
    expect(calls).toHaveLength(2);
  }),
);

it.effect("treats a registry 404 as unpublished without trying another registry", () =>
  Effect.gen(function* () {
    const service = yield* NpmRelease.make().pipe(
      Effect.provideService(ProcessRunner.ProcessRunner, {
        run: () => Effect.succeed(output('{"error":{"code":"E404"}}', 1)),
      }),
    );
    expect(yield* service.get({ spec: version })).toBeNull();
  }),
);

it.effect.each([
  output("not json"),
  output('{"error":{"code":"E401","detail":"sensitive"}}', 1),
  output('{"version":"9.9.9"}'),
  output("[]"),
  { ...output(JSON.stringify({ version })), stdoutTruncated: true },
  { ...output(JSON.stringify({ version })), timedOut: true },
])("reports an unavailable lookup rather than an unpublished release: %j", (result) =>
  Effect.gen(function* () {
    const service = yield* NpmRelease.make().pipe(
      Effect.provideService(ProcessRunner.ProcessRunner, { run: () => Effect.succeed(result) }),
    );
    const found = yield* service.get({ spec: version }).pipe(Effect.result);
    expect(Result.isFailure(found)).toBe(true);
    if (Result.isFailure(found)) {
      expect(found.failure).toBeInstanceOf(ServerNpmReleaseError);
      expect(found.failure.message).not.toContain("sensitive");
    }
  }),
);

it.effect("explains how to restore an unavailable npm without a direct HTTP fallback", () =>
  Effect.gen(function* () {
    const service = yield* NpmRelease.make().pipe(
      Effect.provideService(ProcessRunner.ProcessRunner, {
        run: () =>
          Effect.fail(
            new ProcessRunner.ProcessSpawnError({
              command: "npm",
              argumentCount: 4,
              cause: new Error("not found"),
            }),
          ),
      }),
    );
    const result = yield* service.get({ spec: version }).pipe(Effect.result);
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure.reason).toContain("npm could not be started");
      expect(result.failure.reason).toContain("server's PATH");
    }
  }),
);

it.effect("explains a missing Windows npm shim instead of reporting a registry failure", () =>
  Effect.gen(function* () {
    const service = yield* NpmRelease.make().pipe(
      Effect.provideService(ProcessRunner.ProcessRunner, {
        run: () => Effect.succeed(output("", 9009)),
      }),
      Effect.provideService(HostProcess.Platform, "win32"),
    );
    const result = yield* service.get({ spec: version }).pipe(Effect.result);
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure.reason).toContain("npm could not be started");
      expect(result.failure.reason).toContain("server's PATH");
    }
  }),
);

it.effect.each(["--registry=https://example.com", "../other", "other-package@latest", "*", ""])(
  "rejects invalid release specs before spawning npm: %s",
  (spec) =>
    Effect.gen(function* () {
      const service = yield* NpmRelease.make().pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, {
          run: () => Effect.die("invalid specs must not spawn npm"),
        }),
      );
      expect(Result.isFailure(yield* service.get({ spec }).pipe(Effect.result))).toBe(true);
    }),
);
