import { it, assert } from "@effect/vitest";
import * as Net from "@t3tools/shared/Net";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ProjectScriptPorts from "./ProjectScriptPorts.ts";

const testLayer = (probe: (port: number) => Effect.Effect<boolean>) =>
  ProjectScriptPorts.layer.pipe(
    Layer.provide(
      Layer.mock(Net.NetService)({
        isPortAvailableOnLoopback: probe,
      }),
    ),
    Layer.provide(Path.layer),
  );

it.effect("ProjectScriptPorts-concurrentCollisions-keepsDistinctStableAssignments", () => {
  const probes: number[] = [];
  let available = true;
  return Effect.gen(function* () {
    const probeEntered = yield* Deferred.make<void>();
    const releaseProbe = yield* Deferred.make<void>();
    const layer = testLayer((port) =>
      Effect.gen(function* () {
        probes.push(port);
        if (probes.length === 1) {
          yield* Deferred.succeed(probeEntered, undefined);
          yield* Deferred.await(releaseProbe);
        }
        return available;
      }),
    );
    return yield* Effect.gen(function* () {
      const service = yield* ProjectScriptPorts.ProjectScriptPorts;
      const first = yield* service
        .reserve({ cwd: "/worktree-119", scriptId: "dev" })
        .pipe(Effect.forkChild);
      yield* Deferred.await(probeEntered);
      const contenders = yield* Effect.all(
        [
          service.reserve({ cwd: "/worktree-151", scriptId: "dev" }),
          service.reserve({ cwd: "/worktree-119/../worktree-119", scriptId: "dev" }),
        ],
        { concurrency: "unbounded" },
      ).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      assert.deepEqual(probes, [27170]);
      yield* Deferred.succeed(releaseProbe, undefined);
      const ports = [yield* Fiber.join(first), ...(yield* Fiber.join(contenders))];
      assert.deepEqual(ports, [27170, 27171, 27170]);
      assert.deepEqual(probes, [27170, 27171]);
      available = false;
      assert.equal(yield* service.reserve({ cwd: "/worktree-119", scriptId: "dev" }), 27170);
      assert.equal(probes.length, 2);
    }).pipe(Effect.provide(layer));
  });
});

it.effect("ProjectScriptPorts-occupiedPreferredPort-wrapsAndRestartsDeterministically", () => {
  const layer = testLayer((port) => Effect.succeed(port !== 29999));
  const allocate = Effect.gen(function* () {
    const service = yield* ProjectScriptPorts.ProjectScriptPorts;
    return yield* service.get({ cwd: "/repo", scriptIds: ["dev-7202", "dev", "test", "dev"] });
  });
  return Effect.gen(function* () {
    const first = yield* allocate.pipe(Effect.provide(layer));
    const restarted = yield* allocate.pipe(Effect.provide(layer));
    assert.deepEqual(first, { ports: { "dev-7202": 20000, dev: 24299, test: 27532 } });
    assert.deepEqual(restarted, first);
  });
});

it.effect("ProjectScriptPorts-exhaustedRange-failsWithoutPoisoningRetries", () => {
  let available = false;
  let probes = 0;
  return Effect.gen(function* () {
    const service = yield* ProjectScriptPorts.ProjectScriptPorts;
    const input = { cwd: "/repo", scriptId: "dev" };
    const error = yield* service.reserve(input).pipe(Effect.flip);
    assert.equal(error._tag, "ProjectScriptPortUnavailableError");
    assert.equal(error.startPort, 24299);
    assert.equal(error.attempts, 10000);
    assert.equal(probes, 10000);
    available = true;
    assert.equal(yield* service.reserve(input), 24299);
  }).pipe(
    Effect.provide(
      testLayer(() =>
        Effect.sync(() => {
          probes++;
          return available;
        }),
      ),
    ),
  );
});
