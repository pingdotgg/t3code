import {
  DEFAULT_SERVER_SETTINGS,
  type KeepAwakeMode,
  type OrchestrationV2StoredEvent,
  ThreadId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { TestClock } from "effect/testing";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ServerActivation from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as KeepAwake from "./KeepAwake.ts";

type Step = "sequence" | "query" | "spawn" | "kill";

const makeHarness = Effect.fn("makeKeepAwakeHarness")(function* (options: {
  readonly mode: KeepAwakeMode;
  readonly working?: boolean;
  readonly platform?: NodeJS.Platform;
  readonly parked?: boolean;
}) {
  const steps = yield* Queue.unbounded<Step>();
  const working = yield* Ref.make<boolean | "unreadable">(options.working ?? false);
  const settings = yield* Ref.make({ ...DEFAULT_SERVER_SETTINGS, keepAwake: options.mode });
  const settingsChanges = yield* PubSub.unbounded<typeof DEFAULT_SERVER_SETTINGS>();
  const events = yield* PubSub.unbounded<OrchestrationV2StoredEvent>();
  const committed: Array<OrchestrationV2StoredEvent> = [];
  const activation = yield* Deferred.make<void>();
  const commands: Array<ChildProcess.StandardCommand> = [];
  const exits: Array<Deferred.Deferred<ChildProcessSpawner.ExitCode>> = [];

  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      if (!ChildProcess.isStandardCommand(command)) return yield* Effect.die("Expected a command");
      const exit = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
      commands.push(command);
      exits.push(exit);
      yield* Queue.offer(steps, "spawn");
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(900 + commands.length),
        exitCode: Deferred.await(exit),
        isRunning: Effect.succeed(true),
        kill: () => Queue.offer(steps, "kill").pipe(Effect.asVoid),
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.empty,
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );

  const scope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
    Scope.close(scope, Exit.void),
  );
  yield* Layer.buildWithScope(
    KeepAwake.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ServerSettings.ServerSettingsService)({
            getSettings: Ref.get(settings),
            subscribeChanges: PubSub.subscribe(settingsChanges).pipe(
              Effect.map((subscription) => Stream.fromSubscription(subscription)),
            ),
          }),
          Layer.mock(EventSink.EventSinkV2)({
            latestSequence: () => Queue.offer(steps, "sequence").pipe(Effect.as(committed.length)),
            // Replays past afterSequence like the real sink, so a late subscriber misses nothing.
            stream: (input) =>
              Stream.unwrap(
                PubSub.subscribe(events).pipe(
                  Effect.map((subscription) => {
                    const highWater = committed.length;
                    return Stream.concat(
                      Stream.fromIterable(committed.slice(input?.afterSequence ?? 0)),
                      Stream.fromSubscription(subscription).pipe(
                        Stream.filter((stored) => stored.sequence > highWater),
                      ),
                    ).pipe(Stream.filter((stored) => stored.event.type === input?.eventType));
                  }),
                ),
              ),
          }),
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            hasLiveAgentWork: () =>
              Queue.offer(steps, "query").pipe(
                Effect.andThen(Ref.get(working)),
                Effect.filterOrFail(
                  (live) => live !== "unreadable",
                  () =>
                    new ProjectionStore.ProjectionStoreReadError({
                      threadId: ThreadId.make("thread:shell"),
                      cause: "unreadable",
                    }),
                ),
              ),
          }),
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Layer.succeed(HostProcess.Platform, options.platform ?? "darwin"),
          Layer.succeed(
            ServerActivation.ServerActivation,
            options.parked === true ? Deferred.await(activation) : Effect.void,
          ),
        ),
      ),
    ),
    scope,
  );

  const setMode = (keepAwake: KeepAwakeMode) =>
    Ref.updateAndGet(settings, (current) => ({ ...current, keepAwake })).pipe(
      Effect.flatMap((next) => PubSub.publish(settingsChanges, next)),
    );
  const work = (
    type: "run.created" | "run.updated" | "provider-thread.updated",
    live: boolean | "unreadable",
  ) =>
    Ref.set(working, live).pipe(
      Effect.andThen(
        Effect.suspend(() => {
          const stored = {
            sequence: committed.length + 1,
            event: { type },
          } as OrchestrationV2StoredEvent;
          committed.push(stored);
          return PubSub.publish(events, stored);
        }),
      ),
    );
  const next = Queue.take(steps);
  const idle = Queue.size(steps).pipe(Effect.map((size) => size === 0));

  return { activation, commands, exits, idle, next, scope, setMode, work };
});

it.effect("off holds nothing and asks nothing, even while a run is live", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness({ mode: "off", working: true });
    yield* harness.setMode("whileWorking");
    assert.deepEqual(
      [yield* harness.next, yield* harness.next, yield* harness.next],
      ["sequence", "query", "spawn"],
    );
    assert.deepEqual(
      [harness.commands[0]?.command, harness.commands[0]?.args],
      ["/usr/bin/caffeinate", ["-i", "-w", String(process.pid)]],
    );
  }),
);

it.effect("whileWorking holds from the first live work to the last", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness({ mode: "whileWorking" });
    assert.deepEqual([yield* harness.next, yield* harness.next], ["sequence", "query"]);

    yield* harness.work("run.created", true);
    assert.deepEqual([yield* harness.next, yield* harness.next], ["query", "spawn"]);

    // The run ends while a background subagent still holds its thread.
    yield* harness.work("run.updated", true);
    assert.equal(yield* harness.next, "query");

    yield* harness.work("provider-thread.updated", false);
    assert.deepEqual([yield* harness.next, yield* harness.next], ["query", "kill"]);
    assert.lengthOf(harness.commands, 1);
  }),
);

it.effect("whileWorking holds for work that was already live at startup", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness({ mode: "whileWorking", working: true });
    assert.deepEqual(
      [yield* harness.next, yield* harness.next, yield* harness.next],
      ["sequence", "query", "spawn"],
    );
  }),
);

it.effect("always holds with no work and without asking, until switched off", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness({ mode: "always" });
    assert.equal(yield* harness.next, "spawn");
    yield* harness.setMode("off");
    assert.equal(yield* harness.next, "kill");
    assert.isTrue(yield* harness.idle);
  }),
);

it.effect("switching off mid-run releases the hold", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness({ mode: "whileWorking", working: true });
    assert.deepEqual(
      [yield* harness.next, yield* harness.next, yield* harness.next],
      ["sequence", "query", "spawn"],
    );
    yield* harness.setMode("off");
    assert.equal(yield* harness.next, "kill");
  }),
);

it.effect("closing the server scope releases the hold", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness({ mode: "always" });
    assert.equal(yield* harness.next, "spawn");
    yield* Scope.close(harness.scope, Exit.void);
    assert.equal(yield* harness.next, "kill");
  }),
);

it.effect("an inhibitor that dies is replaced after the backoff", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness({ mode: "always" });
    assert.equal(yield* harness.next, "spawn");
    yield* Deferred.succeed(harness.exits[0]!, ChildProcessSpawner.ExitCode(1));
    assert.equal(yield* harness.next, "kill");
    assert.isTrue(yield* harness.idle);
    yield* TestClock.adjust("1 second");
    assert.equal(yield* harness.next, "spawn");
  }),
);

it.effect("an unreadable projection releases the hold until a later read succeeds", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness({ mode: "whileWorking", working: true });
    assert.deepEqual(
      [yield* harness.next, yield* harness.next, yield* harness.next],
      ["sequence", "query", "spawn"],
    );
    yield* harness.work("run.updated", "unreadable");
    assert.deepEqual([yield* harness.next, yield* harness.next], ["query", "kill"]);

    yield* harness.work("run.updated", true);
    yield* TestClock.adjust("1 second");
    assert.deepEqual(
      [yield* harness.next, yield* harness.next, yield* harness.next],
      ["sequence", "query", "spawn"],
    );
  }),
);

it.effect("a standby server holds nothing until it is activated", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness({ mode: "always", parked: true });
    assert.isTrue(yield* harness.idle);
    yield* Deferred.succeed(harness.activation, undefined);
    assert.equal(yield* harness.next, "spawn");
  }),
);

it.effect("an unsupported platform never holds", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness({ mode: "always", platform: "linux" });
    assert.isTrue(yield* harness.idle);
    assert.lengthOf(harness.commands, 0);
  }),
);
