import { runStream, subscribe } from "@t3tools/client-runtime/rpc";
import {
  createRuntimeCommand,
  followStreamInEnvironment,
  runAtomCommand,
  runStreamInEnvironment,
} from "@t3tools/client-runtime/state/runtime";
import {
  resolveServerUpdateProgressResult,
  serverUpdateFailure,
} from "@t3tools/client-runtime/state/server";
import {
  type EnvironmentId,
  type ServerLifecycleStreamReadyEvent,
  type ServerSelfUpdateResult,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { AsyncResult, type AtomRegistry, Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { engineStateAtom } from "./engine";
import {
  canUpdateEngine,
  type EngineUpdateState,
  offeredRelease,
  PendingUpdate,
  resolveUpdateOutcome,
  type UpdateOutcome,
} from "./engineUpdate";
import { engineEnvironmentIdAtom } from "./projects";
import { serverEnvironment } from "./server";

export const engineVersionAtom = Atom.make(
  (get) =>
    get(serverEnvironment.configValueAtom(get(engineEnvironmentIdAtom)))?.environment
      .serverVersion ?? null,
).pipe(Atom.withLabel("engine-version"));

export interface EngineUpdateOffer {
  readonly targetVersion: string;
  readonly method: "boot-service" | "respawn";
}

/** Reads the release only for an engine the app can update, so other engines pay no lookup. */
export const engineUpdateOfferAtom = Atom.make((get): EngineUpdateOffer | null => {
  const environmentId = get(engineEnvironmentIdAtom);
  const engine = get(engineStateAtom);
  if (environmentId === null || engine.phase !== "ready") return null;
  const environment = get(serverEnvironment.configValueAtom(environmentId))?.environment;
  const method = environment?.capabilities.serverSelfUpdate;
  if (
    environment === undefined ||
    (method !== "boot-service" && method !== "respawn") ||
    !canUpdateEngine(engine.source, method)
  ) {
    return null;
  }
  const release = AsyncResult.getOrElse(
    get(serverEnvironment.npmRelease({ environmentId, input: { spec: "latest" } })),
    () => null,
  );
  const targetVersion = offeredRelease(environment.serverVersion, release?.version ?? null);
  return targetVersion === null ? null : { targetVersion, method };
}).pipe(Atom.withLabel("engine-update-offer"));

export const engineUpdateStateAtom = Atom.make<EngineUpdateState>({ status: "idle" }).pipe(
  Atom.keepAlive,
  Atom.withLabel("engine-update-state"),
);

// A reload loses the running command, so the pending update waits here for the reconnect.
const pendingKey = (environmentId: EnvironmentId) => `board:engine-update:${environmentId}`;
const decodePending = Schema.decodeOption(Schema.fromJsonString(PendingUpdate));
const encodePending = Schema.encodeSync(Schema.fromJsonString(PendingUpdate));

const readPending = (environmentId: EnvironmentId): PendingUpdate | undefined =>
  Option.getOrUndefined(decodePending(localStorage.getItem(pendingKey(environmentId)) ?? ""));
const writePending = (environmentId: EnvironmentId, pending: PendingUpdate) =>
  localStorage.setItem(pendingKey(environmentId), encodePending(pending));
const clearPending = (environmentId: EnvironmentId) =>
  localStorage.removeItem(pendingKey(environmentId));

// The launcher's trial deadline plus a final restart of the old version after a rollback.
const RESUME_TIMEOUT = Duration.minutes(32);
// A live engine replays its ready on subscribe within a round trip.
const BASELINE_TIMEOUT = Duration.seconds(5);

const lifecycleReady = (environmentId: EnvironmentId) =>
  followStreamInEnvironment(environmentId, subscribe(WS_METHODS.subscribeServerLifecycle, {})).pipe(
    Stream.filter((event): event is ServerLifecycleStreamReadyEvent => event.type === "ready"),
  );

const acceptingReadyAt = (environmentId: EnvironmentId) =>
  lifecycleReady(environmentId).pipe(
    Stream.runHead,
    Effect.timeoutOption(BASELINE_TIMEOUT),
    Effect.map((head) => Option.getOrUndefined(Option.flatten(head))?.payload.at),
    Effect.orElseSucceed(() => undefined),
  );

const awaitOutcome = Effect.fn("EngineUpdate.awaitOutcome")(function* (
  environmentId: EnvironmentId,
  pending: PendingUpdate,
  registry: AtomRegistry.AtomRegistry,
) {
  registry.set(engineUpdateStateAtom, {
    status: "running",
    stage: "resuming",
    targetVersion: pending.targetVersion,
  });
  const now = yield* Clock.currentTimeMillis;
  const remaining = Duration.millis(
    Math.max(0, Duration.toMillis(RESUME_TIMEOUT) - (now - pending.startedAt)),
  );
  const outcome = yield* lifecycleReady(environmentId).pipe(
    Stream.map((ready) => resolveUpdateOutcome(pending, ready)),
    Stream.filter((resolved): resolved is UpdateOutcome => resolved !== null),
    Stream.runHead,
    Effect.timeoutOption(remaining),
    Effect.map(Option.flatten),
  );
  clearPending(environmentId);
  registry.set(
    engineUpdateStateAtom,
    Option.isSome(outcome)
      ? { status: "finished", outcome: outcome.value }
      : {
          status: "failed",
          targetVersion: pending.targetVersion,
          message: `Could not confirm that the engine resumed on ${pending.targetVersion}.`,
        },
  );
});

export interface EngineUpdateTarget {
  readonly environmentId: EnvironmentId;
  readonly fromVersion: string;
  readonly targetVersion: string;
  readonly method: EngineUpdateOffer["method"];
}

/** Asks T3's own service to install `targetVersion`, then reports whether it committed. */
export const updateEngine = createRuntimeCommand(connectionAtomRuntime, {
  label: "engine-update:start",
  execute: Effect.fn("EngineUpdate.start")(
    function* (target: EngineUpdateTarget, registry) {
      const { environmentId, targetVersion } = target;
      registry.set(engineUpdateStateAtom, {
        status: "running",
        stage: "downloading",
        targetVersion,
      });
      let pending: PendingUpdate = {
        fromVersion: target.fromVersion,
        targetVersion,
        startedAt: yield* Clock.currentTimeMillis,
      };
      const acceptedAt = yield* acceptingReadyAt(environmentId);
      pending = acceptedAt === undefined ? pending : { ...pending, acceptedAt };
      writePending(environmentId, pending);

      const terminal = yield* Ref.make(Option.none<ServerSelfUpdateResult>());
      let receivedProgress = false;
      const streamExit = yield* runStreamInEnvironment(
        environmentId,
        runStream(WS_METHODS.serverUpdateServerWithProgress, { targetVersion }),
      ).pipe(
        Stream.runForEach((event) =>
          event.type === "complete"
            ? Ref.set(terminal, Option.some(event.result))
            : Effect.sync(() => {
                receivedProgress = true;
                registry.set(engineUpdateStateAtom, {
                  status: "running",
                  stage: event.stage,
                  targetVersion,
                });
              }),
        ),
        Effect.exit,
      );
      const result = yield* resolveServerUpdateProgressResult(
        targetVersion,
        yield* Ref.get(terminal),
        streamExit,
        // A legacy launcher can drop the socket after accepting, so progress alone proves acceptance.
        receivedProgress ? { targetVersion, method: target.method } : undefined,
      );
      pending = result.updateId === undefined ? pending : { ...pending, updateId: result.updateId };
      writePending(environmentId, pending);
      yield* awaitOutcome(environmentId, pending, registry);
    },
    (run, target, registry) =>
      run.pipe(
        Effect.onExit((exit) =>
          Effect.sync(() => {
            if (Exit.isSuccess(exit)) return;
            clearPending(target.environmentId);
            registry.set(
              engineUpdateStateAtom,
              Cause.hasInterruptsOnly(exit.cause)
                ? { status: "idle" }
                : {
                    status: "failed",
                    targetVersion: target.targetVersion,
                    message: serverUpdateFailure(Cause.squash(exit.cause)).message,
                  },
            );
          }),
        ),
      ),
  ),
});

/** Picks up an update a reload interrupted, and reports its outcome after the reconnect. */
export const resumeEngineUpdate = createRuntimeCommand(connectionAtomRuntime, {
  label: "engine-update:resume",
  execute: (target: { readonly environmentId: EnvironmentId }, registry) => {
    const pending = readPending(target.environmentId);
    return pending === undefined || registry.get(engineUpdateStateAtom).status !== "idle"
      ? Effect.void
      : awaitOutcome(target.environmentId, pending, registry);
  },
});

/** Mounted by the footer: picks up an update a reload interrupted as soon as the engine is known. */
export const engineUpdateResumeAtom = Atom.make((get) => {
  const environmentId = get(engineEnvironmentIdAtom);
  if (environmentId !== null) {
    void runAtomCommand(
      get.registry,
      resumeEngineUpdate,
      { environmentId },
      { reportFailure: false },
    );
  }
}).pipe(Atom.withLabel("engine-update-resume"));
