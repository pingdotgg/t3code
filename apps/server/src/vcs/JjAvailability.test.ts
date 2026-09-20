import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/unstable/process";

import { VcsProcessSpawnError } from "@t3tools/contracts";
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
        cause: new Error("spawn jj ENOENT"),
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
    return probeOnce(versionProcess("jj 0.42.0\n", calls)).pipe(
      Effect.map((availability) => {
        assert.deepStrictEqual(availability, { _tag: "available", version: "0.42.0" });
      }),
    );
  });

  it.effect("ignores the commit suffix of a source build", () => {
    const calls = { count: 0 };
    return probeOnce(
      versionProcess("jj 0.45.1-7c41cdeb16b6b321c64e789a966b6adf723816a5\n", calls),
    ).pipe(
      Effect.map((availability) => {
        assert.deepStrictEqual(availability, { _tag: "available", version: "0.45.1" });
      }),
    );
  });

  it.effect("rejects a binary below the floor", () => {
    const calls = { count: 0 };
    return probeOnce(versionProcess("jj 0.41.9\n", calls)).pipe(
      Effect.map((availability) => {
        assert.deepStrictEqual(availability, { _tag: "unsupported-version", version: "0.41.9" });
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

  it.effect("probes once no matter how many callers ask", () => {
    const calls = { count: 0 };

    return Effect.gen(function* () {
      const availability = yield* JjAvailability.makeJjAvailability;
      yield* Effect.all([availability("/repo"), availability("/other"), availability("/repo")], {
        concurrency: "unbounded",
      });

      assert.equal(calls.count, 1);
    }).pipe(Effect.provide(versionProcess("jj 0.42.0\n", calls)));
  });
});

describe("jjUnsupportedReason", () => {
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
      reasonFor({ availability: { _tag: "available", version: "0.42.0" }, colocated: false }),
    );
    assert.isFalse(
      reasonFor({ availability: { _tag: "available", version: "0.42.0" }, colocated: true }),
    );
  });
});
