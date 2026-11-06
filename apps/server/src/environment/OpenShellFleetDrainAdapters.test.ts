import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { type PlatformError } from "effect/PlatformError";

import { FleetDrainStepError, type DrainSink } from "./OpenShellFleetDrain.ts";
import * as OpenShellFleetDrainAdapters from "./OpenShellFleetDrainAdapters.ts";

type SinkUse<A> = Effect.Effect<
  A,
  FleetDrainStepError | PlatformError,
  FileSystem.FileSystem | Path.Path
>;

const refused = <A>(
  effect: Effect.Effect<A, FleetDrainStepError, never>,
): Effect.Effect<FleetDrainStepError, never, never> =>
  effect.pipe(
    Effect.flip,
    Effect.catch(() => Effect.die(new Error("expected a refusal"))),
  );

const withSink = <A>(use: (sink: DrainSink, stateDir: string) => SinkUse<A>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const stateDir = yield* fs.makeTempDirectory();
    const sink = OpenShellFleetDrainAdapters.fileDrainSink({ stateDir, fs, path });
    return yield* use(sink, stateDir);
  }).pipe(Effect.provide(NodeServices.layer));

const write = (
  sink: DrainSink,
  overrides: Partial<{
    environmentId: EnvironmentId;
    drainId: string;
    threadId: string;
    body: string;
  }> = {},
) =>
  sink.write({
    environmentId: EnvironmentId.make("environment:worker"),
    drainId: "drain:environment:worker:1",
    threadId: "thread:a",
    body: '{"events":[1]}',
    snapshotSequence: 4,
    ...overrides,
  });

describe("fileDrainSink", () => {
  it.effect("refuses an environment id that climbs out of fleet-drain", () =>
    withSink((sink) =>
      Effect.gen(function* () {
        const failure = yield* refused(write(sink, { environmentId: EnvironmentId.make("..") }));
        expect(failure.step).toBe("write");
        const readFailure = yield* refused(
          sink.read({
            environmentId: EnvironmentId.make(".."),
            drainId: "drain:environment:worker:1",
            threadId: "thread:a",
          }),
        );
        expect(readFailure.step).toBe("read");
      }),
    ),
  );

  it.effect("refuses a drain id that climbs out of fleet-drain", () =>
    withSink((sink) =>
      Effect.gen(function* () {
        const failure = yield* refused(write(sink, { drainId: ".." }));
        expect(failure.step).toBe("write");
        const readFailure = yield* refused(
          sink.read({
            environmentId: EnvironmentId.make("environment:worker"),
            drainId: "..",
            threadId: "thread:a",
          }),
        );
        expect(readFailure.step).toBe("read");
      }),
    ),
  );

  it.effect("neutralizes separators and stores a currency-checked envelope", () =>
    withSink((sink, stateDir) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const written = yield* write(sink, {
          environmentId: EnvironmentId.make("env/../../elsewhere"),
        });
        expect(written.bytes).toBeGreaterThan(0);
        // The segment cannot name a directory above fleet-drain.
        expect(yield* fs.exists(path.join(stateDir, "elsewhere"))).toBe(false);
        const record = yield* sink.read({
          environmentId: EnvironmentId.make("env/../../elsewhere"),
          drainId: "drain:environment:worker:1",
          threadId: "thread:a",
        });
        expect(record).toEqual({
          threadId: "thread:a",
          snapshotSequence: 4,
          body: '{"events":[1]}',
        });
      }),
    ),
  );

  it.effect("answers null for a thread that was never written", () =>
    withSink((sink) =>
      Effect.gen(function* () {
        const record = yield* sink.read({
          environmentId: EnvironmentId.make("environment:worker"),
          drainId: "drain:environment:worker:1",
          threadId: "thread:missing",
        });
        expect(record).toBeNull();
      }),
    ),
  );
});
