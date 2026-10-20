import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/process";

import {
  VcsProcessSpawnError,
  VcsProcessTimeoutError,
  VcsProcessOutputLimitError,
} from "@t3tools/contracts";
import * as ServerConfig from "../config.ts";
import * as SourceControlDiscovery from "../sourceControl/SourceControlDiscovery.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as JjAvailability from "./JjAvailability.ts";
import * as VcsProcess from "./VcsProcess.ts";

const versionProcess = (stdout: string, calls: { count: number }) =>
  Layer.mock(VcsProcess.VcsProcess)({
    run: () =>
      Effect.sync(() => {
        calls.count += 1;
        return {
          exitCode: ChildProcessSpawner.ExitCode(0),
          stdout,
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
        };
      }),
  });

const missingBinaryProcess = Layer.mock(VcsProcess.VcsProcess)({
  run: (input) =>
    Effect.fail(
      new VcsProcessSpawnError({
        operation: input.operation,
        command: input.command,
        cwd: input.cwd,
        cause: Object.assign(new Error("spawn jj ENOENT"), { code: "ENOENT" }),
      }),
    ),
});

const probeOnce = (layer: Layer.Layer<VcsProcess.VcsProcess>) =>
  Effect.gen(function* () {
    const availability = yield* JjAvailability.makeJjAvailability;
    return yield* availability("/repo");
  }).pipe(Effect.provide(layer));

describe("makeJjAvailability", () => {
  it.effect("accepts a release build at the supported floor", () => {
    const calls = { count: 0 };
    return probeOnce(versionProcess("jj 0.46.0\n", calls)).pipe(
      Effect.map((availability) => {
        assert.deepStrictEqual(availability, { _tag: "available", version: "0.46.0" });
      }),
    );
  });

  it.effect("ignores the commit suffix of a source build", () => {
    const calls = { count: 0 };
    return probeOnce(
      versionProcess("jj 0.46.0-7c41cdeb16b6b321c64e789a966b6adf723816a5\n", calls),
    ).pipe(
      Effect.map((availability) => {
        assert.deepStrictEqual(availability, { _tag: "available", version: "0.46.0" });
      }),
    );
  });

  it.effect("rejects a binary below the floor", () => {
    const calls = { count: 0 };
    return probeOnce(versionProcess("jj 0.45.9\n", calls)).pipe(
      Effect.map((availability) => {
        assert.deepStrictEqual(availability, { _tag: "unsupported-version", version: "0.45.9" });
      }),
    );
  });

  it.effect("reports a missing binary instead of failing", () =>
    probeOnce(missingBinaryProcess).pipe(
      Effect.map((availability) => {
        assert.deepStrictEqual(availability, { _tag: "missing" });
      }),
    ),
  );

  it.effect("reports permission failures as a broken install", () =>
    probeOnce(
      Layer.mock(VcsProcess.VcsProcess)({
        run: (input) =>
          Effect.fail(
            new VcsProcessSpawnError({
              operation: input.operation,
              command: input.command,
              cwd: input.cwd,
              cause: Object.assign(new Error("spawn jj EACCES"), { code: "EACCES" }),
            }),
          ),
      }),
    ).pipe(
      Effect.map((availability) => {
        assert.deepStrictEqual(availability, {
          _tag: "broken",
          detail: "jj could not be executed",
        });
      }),
    ),
  );

  it.effect("reports a timed out probe as a broken install", () =>
    probeOnce(
      Layer.mock(VcsProcess.VcsProcess)({
        run: (input) =>
          Effect.fail(
            new VcsProcessTimeoutError({
              operation: input.operation,
              command: input.command,
              cwd: input.cwd,
              timeoutMs: 5_000,
            }),
          ),
      }),
    ).pipe(
      Effect.map((availability) => {
        assert.deepStrictEqual(availability, {
          _tag: "broken",
          detail: "jj did not respond within 5 seconds",
        });
      }),
    ),
  );

  it.effect("reports excessive version output without process internals", () =>
    probeOnce(
      Layer.mock(VcsProcess.VcsProcess)({
        run: (input) =>
          Effect.fail(
            new VcsProcessOutputLimitError({
              operation: input.operation,
              command: input.command,
              cwd: input.cwd,
              stream: "stdout",
              maxBytes: 4_096,
              observedBytes: 4_097,
            }),
          ),
      }),
    ).pipe(
      Effect.map((availability) => {
        assert.deepStrictEqual(availability, {
          _tag: "broken",
          detail: "jj returned too much version output",
        });
      }),
    ),
  );
  for (const stderr of ["", "version wrapper is broken"]) {
    it.effect(
      `reports a successful malformed executable as broken (${stderr || "no stderr"})`,
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-jj-version-" });
          const executable = path.join(directory, "jj");
          yield* fileSystem.writeFileString(
            executable,
            `#!/bin/sh\nprintf '%s\\n' 'invalid version'\nprintf '%s' '${stderr}' >&2\n`,
          );
          yield* fileSystem.chmod(executable, 0o755);
          const process = yield* VcsProcess.VcsProcess;
          const availability = yield* JjAvailability.makeJjAvailability.pipe(
            Effect.provideService(VcsProcess.VcsProcess, {
              run: (input) => process.run({ ...input, command: executable }),
            }),
          );
          assert.deepStrictEqual(yield* availability(directory), {
            _tag: "broken",
            detail: stderr || "Jujutsu version probe returned an invalid version banner.",
          });
        }).pipe(Effect.provide(VcsProcess.layer.pipe(Layer.provideMerge(NodeServices.layer)))),
    );
  }

  it.effect("probes once per repository no matter how many callers ask", () => {
    const calls = { count: 0 };

    return Effect.gen(function* () {
      const availability = yield* JjAvailability.makeJjAvailability;
      yield* Effect.all([availability("/repo"), availability("/other"), availability("/repo")], {
        concurrency: "unbounded",
      });

      assert.equal(calls.count, 2);
    }).pipe(Effect.provide(versionProcess("jj 0.46.0\n", calls)));
  });

  it.effect.each(["missing", "timeout", "unsupported", "invalid", "failed"] as const)(
    "caches a %s result briefly, then re-probes and caches recovery",
    (first) => {
      let calls = 0;
      const process = Layer.mock(VcsProcess.VcsProcess)({
        run: (input) =>
          Effect.suspend(
            (): Effect.Effect<
              VcsProcess.VcsProcessOutput,
              VcsProcessSpawnError | VcsProcessTimeoutError
            > => {
              calls += 1;
              if (calls === 1 && first === "missing") {
                return Effect.fail(
                  new VcsProcessSpawnError({
                    operation: input.operation,
                    command: input.command,
                    cwd: input.cwd,
                    cause: new Error("not installed"),
                  }),
                );
              }
              if (calls === 1 && first === "timeout") {
                return Effect.fail(
                  new VcsProcessTimeoutError({
                    operation: input.operation,
                    command: input.command,
                    cwd: input.cwd,
                    timeoutMs: 5_000,
                  }),
                );
              }
              return Effect.succeed({
                exitCode: ChildProcessSpawner.ExitCode(calls === 1 && first === "failed" ? 1 : 0),
                stdout: calls > 1 ? "jj 0.46.0\n" : first === "unsupported" ? "jj 0.45.0\n" : "",
                stderr: "",
                stdoutTruncated: false,
                stderrTruncated: false,
              });
            },
          ),
      });
      return Effect.gen(function* () {
        const availability = yield* JjAvailability.makeJjAvailability;
        const initial = yield* availability("/repo");
        assert.notEqual(initial._tag, "available");
        const repeated = yield* Effect.all(
          [availability("/repo"), availability("/repo"), availability("/repo")],
          { concurrency: "unbounded" },
        );
        for (const result of repeated) assert.deepStrictEqual(result, initial);
        assert.equal(calls, 1);
        yield* TestClock.adjust("29 seconds");
        assert.deepStrictEqual(yield* availability("/repo"), initial);
        assert.equal(calls, 1);
        yield* TestClock.adjust("1 second");
        assert.deepStrictEqual(yield* availability("/repo"), {
          _tag: "available",
          version: "0.46.0",
        });
        yield* availability("/repo");
        yield* TestClock.adjust("1 minute");
        yield* availability("/repo");
        assert.equal(calls, 2);
      }).pipe(Effect.provide(process));
    },
  );

  it.effect("invalidates cached probes immediately for the rescanned process only", () => {
    const calls = { count: 0 };
    return Effect.gen(function* () {
      const process = yield* VcsProcess.VcsProcess;
      const availability = yield* JjAvailability.makeJjAvailability;
      yield* availability("/repo");
      JjAvailability.invalidateJjAvailability({ ...process });
      yield* availability("/repo");
      assert.equal(calls.count, 1);
      JjAvailability.invalidateJjAvailability(process);
      yield* availability("/repo");
      assert.equal(calls.count, 2);
    }).pipe(Effect.provide(versionProcess("jj 0.45.0\n", calls)));
  });

  it.effect("Settings discovery invalidates a missing probe before its TTL expires", () => {
    const calls = { count: 0 };
    return Effect.gen(function* () {
      const availability = yield* JjAvailability.makeJjAvailability;
      assert.deepStrictEqual(yield* availability("/repo"), { _tag: "missing" });
      assert.equal(calls.count, 1);
      const discovery = yield* SourceControlDiscovery.make;
      yield* discovery.discover;
      assert.deepStrictEqual(yield* availability("/repo"), {
        _tag: "available",
        version: "0.46.0",
      });
      assert.equal(calls.count, 4);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          ServerConfig.layerTest("/repo", {
            prefix: "t3-jj-availability-discovery-",
          }).pipe(Layer.provide(NodeServices.layer)),
          Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
            resolveLink: () => undefined,
            discover: Effect.succeed([]),
          }),
          Layer.mock(VcsProcess.VcsProcess)({
            run: (input) =>
              Effect.suspend(() => {
                calls.count += 1;
                if (calls.count === 1) {
                  return Effect.fail(
                    new VcsProcessSpawnError({
                      operation: input.operation,
                      command: input.command,
                      cwd: input.cwd,
                      cause: { code: "ENOENT" },
                    }),
                  );
                }
                return Effect.succeed({
                  exitCode: ChildProcessSpawner.ExitCode(0),
                  stdout: "jj 0.46.0\n",
                  stderr: "",
                  stdoutTruncated: false,
                  stderrTruncated: false,
                });
              }),
          }),
        ),
      ),
    );
  });
});

describe("jjUnsupportedReason", () => {
  it("recommends enabling colocation in an existing Jujutsu repository", () => {
    const reason = JjAvailability.jjUnsupportedReason({
      availability: { _tag: "available", version: "0.46.0" },
      colocated: false,
    });
    assert.include(reason, "jj git colocation enable");
    assert.notInclude(reason, "jj git init");
  });

  it("prioritizes colocation over a missing binary and describes the server PATH", () => {
    const reason = JjAvailability.jjUnsupportedReason({
      availability: { _tag: "missing" },
      colocated: false,
    });
    assert.include(reason, "jj git colocation enable");
    assert.include(reason, "not found on the server’s PATH");
    assert.isBelow(reason!.indexOf("colocated"), reason!.indexOf("not found"));
    assert.include(
      JjAvailability.jjUnsupportedReason({ availability: { _tag: "missing" }, colocated: true }),
      "not found on the server’s PATH",
    );
  });

  it("reports a reason for every unusable repository and stays silent for a usable one", () => {
    const reasonFor = (input: Parameters<typeof JjAvailability.jjUnsupportedReason>[0]) =>
      JjAvailability.jjUnsupportedReason(input) !== null;

    assert.isTrue(reasonFor({ availability: { _tag: "missing" }, colocated: true }));
    assert.isTrue(
      reasonFor({
        availability: { _tag: "unsupported-version", version: "0.41.0" },
        colocated: true,
      }),
    );
    assert.isTrue(
      reasonFor({ availability: { _tag: "available", version: "0.46.0" }, colocated: false }),
    );
    assert.isFalse(
      reasonFor({ availability: { _tag: "available", version: "0.46.0" }, colocated: true }),
    );
  });
});
