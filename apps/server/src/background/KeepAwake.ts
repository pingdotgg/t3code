/**
 * Holds off idle system sleep on the server's machine, as the `keepAwake` setting asks.
 *
 * @module KeepAwake
 */
import type { KeepAwakeMode } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";

class KeepAwakeInhibitorExited extends Schema.TaggedError<KeepAwakeInhibitorExited>()(
  "KeepAwakeInhibitorExited",
  { exitCode: Schema.Number },
) {
  override get message(): string {
    return `The sleep inhibitor exited with code ${this.exitCode}.`;
  }
}

/** The capability and the worker both read this, so a platform cannot advertise a hold it lacks. */
export const keepAwakeSupported = (platform: NodeJS.Platform): boolean => platform === "darwin";

// -i blocks idle system sleep only; -w drops the assertion if the server dies without finalizers.
const inhibitor = ChildProcess.make("/usr/bin/caffeinate", ["-i", "-w", String(process.pid)], {
  stdin: "ignore",
  stdout: "ignore",
  stderr: "ignore",
  killSignal: "SIGTERM",
  forceKillAfter: Duration.seconds(2),
});

const WORK_EVENT_TYPES = ["run.created", "run.updated", "provider-thread.updated"] as const;

const restartSchedule = Schedule.exponential("1 second").pipe(
  Schedule.modifyDelay(({ duration }) =>
    Effect.succeed(Duration.min(duration, Duration.minutes(1))),
  ),
);

const make = Effect.gen(function* () {
  if (!keepAwakeSupported(yield* HostProcess.Platform)) return;
  const settings = yield* ServerSettings.ServerSettingsService;
  const eventSink = yield* EventSink.EventSinkV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const hold = Effect.fn("KeepAwake.hold")(function* () {
    const child = yield* Effect.acquireRelease(spawner.spawn(inhibitor), (child) =>
      child.kill().pipe(Effect.ignore),
    );
    const exitCode = yield* child.exitCode;
    return yield* new KeepAwakeInhibitorExited({ exitCode });
  }, Effect.scoped);

  // The sequence is read before the first query, so an event committed in between is replayed.
  const agentsWorking = Stream.unwrap(
    Effect.gen(function* () {
      const afterSequence = yield* eventSink.latestSequence();
      const workEvents = Stream.mergeAll(
        WORK_EVENT_TYPES.map((eventType) => eventSink.stream({ afterSequence, eventType })),
        { concurrency: "unbounded" },
      );
      return Stream.concat(Stream.succeed(undefined), workEvents).pipe(
        Stream.buffer({ capacity: 1, strategy: "sliding" }),
        Stream.mapEffect(() => projections.hasLiveAgentWork()),
      );
    }),
  );

  const shouldHold = (mode: KeepAwakeMode) => {
    switch (mode) {
      case "off":
        return Stream.succeed(false);
      case "always":
        return Stream.succeed(true);
      case "whileWorking":
        return agentsWorking;
    }
  };

  const run = Effect.gen(function* () {
    const changes = yield* settings.subscribeChanges;
    const initial = yield* settings.getSettings;
    yield* Stream.concat(Stream.succeed(initial), changes).pipe(
      Stream.map((current) => current.keepAwake),
      Stream.changes,
      Stream.switchMap(shouldHold),
      Stream.changes,
      Stream.switchMap((awake) => (awake ? Stream.fromEffect(hold()) : Stream.empty)),
      Stream.runDrain,
    );
  }).pipe(
    Effect.scoped,
    Effect.tapCause((cause) =>
      Effect.logWarning("Keep-awake failed and released its hold; restarting", { cause }),
    ),
    Effect.retry(restartSchedule),
  );

  yield* forkParked(run);
});

export const layer = Layer.effectDiscard(make);
