import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as TestClock from "effect/testing/TestClock";

import type * as ProviderRuntimeRecovery from "./orchestration-v2/ProviderRuntimeRecoveryService.ts";
import * as ServerRuntimeStartup from "./serverRuntimeStartup.ts";
import { makeUpdatePauseController } from "./updatePauseController.ts";

const summary = {
  terminalizedRuns: 1,
  stoppedSessions: 1,
  closedRequests: 0,
  retiredEffects: 0,
  requeuedEffects: 0,
};

const setup = Effect.gen(function* () {
  const gate = yield* ServerRuntimeStartup.makeCommandGate;
  yield* gate.signalCommandReady;
  const calls: Array<string> = [];
  const record = (call: string) => Effect.sync(() => void calls.push(call));
  const controller = yield* makeUpdatePauseController({
    closeCommands: gate.closeCommands(
      new ServerRuntimeStartup.ServerRuntimeStartupError({
        mode: "web",
        host: null,
        port: 3773,
        cause: "pausing",
      }),
    ),
    reopenCommands: gate.reopenCommands,
    stopEffectWorker: record("stop worker"),
    startEffectWorker: record("start worker"),
    recovery: {
      prepareForUpdate: Effect.succeed([
        {} as ProviderRuntimeRecovery.RunningProviderTurn,
        {} as ProviderRuntimeRecovery.RunningProviderTurn,
      ]),
      reconcile: (trigger, options) =>
        record(`reconcile ${trigger} ${options?.update}`).pipe(Effect.as(summary)),
    },
    sessions: {
      interruptForShutdown: (turns) => record(`interrupt ${turns.length}`),
      shutdown: record("release sessions"),
      resumeEventIngestion: record("ingest events"),
    },
  });
  const commandAccepted = Effect.exit(gate.enqueueCommand(Effect.void)).pipe(
    Effect.map(Exit.isSuccess),
  );
  return { controller, calls, commandAccepted };
});

const PAUSE = ["stop worker", "interrupt 2"];
const UNPAUSE = [
  "release sessions",
  "ingest events",
  "reconcile shutdown not-installed",
  "start worker",
];

it.effect("un-pauses once at the deadline when no restart follows the pause", () =>
  Effect.gen(function* () {
    const { controller, calls, commandAccepted } = yield* setup;
    assert.deepEqual(yield* controller.pauseRunsForUpdate, { pausedRuns: 2 });
    assert.deepEqual(yield* controller.pauseRunsForUpdate, { pausedRuns: 2 });
    assert.isFalse(yield* commandAccepted);

    yield* TestClock.adjust("119 seconds");
    assert.deepEqual(calls, PAUSE);
    yield* TestClock.adjust("1 second");
    assert.deepEqual(calls, [...PAUSE, ...UNPAUSE]);
    assert.isTrue(yield* commandAccepted);

    yield* controller.resumeRunsAfterUpdate;
    yield* TestClock.adjust("10 minutes");
    assert.deepEqual(calls, [...PAUSE, ...UNPAUSE]);
  }),
);

it.effect("un-pauses at once when the updater reports a failed install", () =>
  Effect.gen(function* () {
    const { controller, calls, commandAccepted } = yield* setup;
    yield* controller.pauseRunsForUpdate;
    yield* controller.resumeRunsAfterUpdate;
    assert.deepEqual(calls, [...PAUSE, ...UNPAUSE]);
    assert.isTrue(yield* commandAccepted);

    yield* TestClock.adjust("10 minutes");
    assert.deepEqual(calls, [...PAUSE, ...UNPAUSE]);
    assert.deepEqual(yield* controller.pauseRunsForUpdate, { pausedRuns: 2 });
    assert.deepEqual(calls, [...PAUSE, ...UNPAUSE, ...PAUSE]);
  }),
);

it.effect("keeps the pause when the update stops the server", () =>
  Effect.gen(function* () {
    const { controller, calls } = yield* setup;
    yield* controller.pauseRunsForUpdate;
    assert.isTrue(yield* controller.beginShutdown);
    yield* TestClock.adjust("10 minutes");
    yield* controller.resumeRunsAfterUpdate;
    assert.deepEqual(calls, PAUSE);
  }),
);
