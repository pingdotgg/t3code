import type { KeepHostAwakeMode, OrchestrationV2DomainEvent } from "@t3tools/contracts";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as HostWakeLock from "./HostWakeLock.ts";

const runUpdated = { type: "run.updated" } as OrchestrationV2DomainEvent;
const providerThreadUpdated = { type: "provider-thread.updated" } as OrchestrationV2DomainEvent;
const turnItemUpdated = { type: "turn-item.updated" } as OrchestrationV2DomainEvent;

const setup = Effect.fn("HostWakeLockTest.setup")(function* (input: {
  readonly mode: KeepHostAwakeMode;
  readonly working?: boolean;
  /** Helpers exit by themselves instead of holding until killed. */
  readonly exitsEarly?: boolean;
}) {
  const mode = yield* Ref.make(input.mode);
  const working = yield* Ref.make(input.working ?? false);
  const workingReads = yield* Ref.make(0);
  const spawns = yield* Ref.make(0);
  const spawned = yield* Queue.unbounded<void>();
  const released = yield* Queue.unbounded<void>();
  const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
  const settingsChanges = yield* Queue.unbounded<KeepHostAwakeMode>();

  const dependencies = Layer.mergeAll(
    Layer.mock(Orchestrator.OrchestratorV2)({ streamDomainEvents: Stream.fromQueue(events) }),
    Layer.mock(ProjectionStore.ProjectionStoreV2)({
      hasWorkingRuns: () =>
        Ref.update(workingReads, (reads) => reads + 1).pipe(Effect.andThen(Ref.get(working))),
    }),
    Layer.mock(ServerSettings.ServerSettingsService)({
      getSettings: Ref.get(mode).pipe(
        Effect.map((keepHostAwake) => ({ ...DEFAULT_SERVER_SETTINGS, keepHostAwake })),
      ),
      subscribeChanges: Effect.succeed(
        Stream.fromQueue(settingsChanges).pipe(
          Stream.map((keepHostAwake) => ({ ...DEFAULT_SERVER_SETTINGS, keepHostAwake })),
        ),
      ),
    }),
    Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make(() =>
        Effect.gen(function* () {
          yield* Ref.update(spawns, (count) => count + 1);
          yield* Effect.addFinalizer(() => Queue.offer(released, undefined));
          yield* Queue.offer(spawned, undefined);
          return ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(1),
            exitCode:
              input.exitsEarly === true
                ? Effect.succeed(ChildProcessSpawner.ExitCode(1))
                : Effect.never,
            isRunning: Effect.succeed(true),
            kill: () => Effect.void,
            unref: Effect.succeed(Effect.void),
            stdin: Sink.drain,
            stdout: Stream.empty,
            stderr: Stream.empty,
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          });
        }),
      ),
    ),
  );
  const service = yield* HostWakeLock.make.pipe(Effect.provide(dependencies));
  yield* service.start().pipe(Effect.provide(dependencies));

  return {
    events,
    released,
    spawned,
    spawns,
    working,
    workingReads,
    setMode: (next: KeepHostAwakeMode) =>
      Ref.set(mode, next).pipe(Effect.andThen(Queue.offer(settingsChanges, next))),
  };
});

describe("HostWakeLock", () => {
  it.effect("holds one lock while runs work and releases it when they stop", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const host = yield* setup({ mode: "whileWorking" });

        yield* Ref.set(host.working, true);
        yield* Queue.offer(host.events, runUpdated);
        yield* Queue.take(host.spawned);
        yield* Queue.offerAll(host.events, [runUpdated, runUpdated]);

        yield* Ref.set(host.working, false);
        yield* Queue.offer(host.events, runUpdated);
        yield* Queue.take(host.released);
        expect(yield* Ref.get(host.spawns)).toBe(1);
      }),
    ),
  );

  it.effect("takes the lock at startup for runs that are already working", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const host = yield* setup({ mode: "whileWorking", working: true });
        yield* Queue.take(host.spawned);
      }),
    ),
  );

  it.effect("follows the setting without reading runs outside while-working mode", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const host = yield* setup({ mode: "off", working: true });
        yield* Queue.offer(host.events, runUpdated);

        yield* host.setMode("always");
        yield* Queue.take(host.spawned);

        yield* host.setMode("off");
        yield* Queue.take(host.released);
        expect(yield* Ref.get(host.workingReads)).toBe(0);
        expect(yield* Ref.get(host.spawns)).toBe(1);
      }),
    ),
  );

  it.effect("ignores events that cannot change whether a run is working", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const host = yield* setup({ mode: "whileWorking" });
        yield* Ref.set(host.working, true);
        yield* Queue.offer(host.events, turnItemUpdated);

        yield* Queue.offer(host.events, runUpdated);
        yield* Queue.take(host.spawned);
        // One read at startup, one for the run event.
        expect(yield* Ref.get(host.workingReads)).toBe(2);
      }),
    ),
  );

  it.effect("reconciles when a provider thread's background roster changes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const host = yield* setup({ mode: "whileWorking" });

        yield* Ref.set(host.working, true);
        yield* Queue.offer(host.events, providerThreadUpdated);
        yield* Queue.take(host.spawned);

        yield* Ref.set(host.working, false);
        yield* Queue.offer(host.events, providerThreadUpdated);
        yield* Queue.take(host.released);
        expect(yield* Ref.get(host.spawns)).toBe(1);
      }),
    ),
  );

  it.effect("takes the lock again after the helper exits by itself", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const host = yield* setup({ mode: "always", exitsEarly: true });
        yield* Queue.take(host.released);

        yield* Queue.offer(host.events, runUpdated);
        yield* Queue.take(host.released);
        expect(yield* Ref.get(host.spawns)).toBe(2);
      }),
    ),
  );

  it.effect("releases the lock when the server shuts down", () =>
    Effect.gen(function* () {
      const released = yield* Effect.scoped(
        Effect.gen(function* () {
          const host = yield* setup({ mode: "always" });
          yield* Queue.take(host.spawned);
          return host.released;
        }),
      );
      yield* Queue.take(released);
    }),
  );
});
