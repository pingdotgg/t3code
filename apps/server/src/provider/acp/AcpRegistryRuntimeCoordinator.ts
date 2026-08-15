import { type ProviderInstanceId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import type { AcpRegistryAvailableCommands } from "./AcpRegistryProbe.ts";

interface AvailableCommandsUpdate {
  readonly instanceId: ProviderInstanceId;
  readonly commands: AcpRegistryAvailableCommands;
}

/** Gives a user-started ACP process priority over disposable discovery for the same agent. */
export class AcpRegistryRuntimeCoordinator extends Context.Service<
  AcpRegistryRuntimeCoordinator,
  {
    readonly withForegroundStartup: <A, E, R>(
      agentId: string,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E, R>;
    readonly runBackgroundProbe: <A, E, R>(
      agentId: string,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<Option.Option<A>, E, R>;
    readonly clearAvailableCommands: (instanceId: ProviderInstanceId) => Effect.Effect<void>;
    readonly publishAvailableCommands: (
      instanceId: ProviderInstanceId,
      commands: AcpRegistryAvailableCommands,
    ) => Effect.Effect<void>;
    readonly getAvailableCommands: (
      instanceId: ProviderInstanceId,
    ) => Effect.Effect<Option.Option<AcpRegistryAvailableCommands>>;
    readonly watchAvailableCommands: (
      instanceId: ProviderInstanceId,
      onUpdate: (commands: AcpRegistryAvailableCommands) => Effect.Effect<void>,
    ) => Effect.Effect<void>;
  }
>()("t3/provider/acp/AcpRegistryRuntimeCoordinator") {
  static get layer() {
    return layer;
  }
}

export const make = Effect.gen(function* () {
  const foregroundStarts = yield* PubSub.unbounded<string>();
  const activeForegroundCounts = yield* Ref.make(new Map<string, number>());
  const availableCommandsUpdates = yield* PubSub.unbounded<AvailableCommandsUpdate>();
  const availableCommandsByInstance = yield* Ref.make(
    new Map<ProviderInstanceId, AcpRegistryAvailableCommands>(),
  );

  const withForegroundStartup: AcpRegistryRuntimeCoordinator["Service"]["withForegroundStartup"] = (
    agentId,
    effect,
  ) =>
    Effect.acquireUseRelease(
      Ref.update(activeForegroundCounts, (current) => {
        const next = new Map(current);
        next.set(agentId, (next.get(agentId) ?? 0) + 1);
        return next;
      }).pipe(Effect.andThen(PubSub.publish(foregroundStarts, agentId))),
      () => effect,
      () =>
        Ref.update(activeForegroundCounts, (current) => {
          const next = new Map(current);
          const remaining = (next.get(agentId) ?? 1) - 1;
          if (remaining <= 0) next.delete(agentId);
          else next.set(agentId, remaining);
          return next;
        }),
    );

  const runBackgroundProbe: AcpRegistryRuntimeCoordinator["Service"]["runBackgroundProbe"] = (
    agentId,
    effect,
  ) =>
    Effect.scoped(
      Effect.gen(function* () {
        // Subscribe before checking state so a foreground start cannot land
        // in the gap between the check and the interruptible probe.
        const subscription = yield* PubSub.subscribe(foregroundStarts);
        if ((yield* Ref.get(activeForegroundCounts)).has(agentId)) {
          return Option.none();
        }
        const foregroundStarted = Stream.fromSubscription(subscription).pipe(
          Stream.filter((candidate) => candidate === agentId),
          Stream.runHead,
          Effect.as(Option.none()),
        );
        return yield* Effect.raceFirst(effect.pipe(Effect.map(Option.some)), foregroundStarted);
      }),
    );

  const clearAvailableCommands: AcpRegistryRuntimeCoordinator["Service"]["clearAvailableCommands"] =
    (instanceId) =>
      Ref.update(availableCommandsByInstance, (current) => {
        const next = new Map(current);
        next.delete(instanceId);
        return next;
      });

  const publishAvailableCommands: AcpRegistryRuntimeCoordinator["Service"]["publishAvailableCommands"] =
    (instanceId, commands) =>
      Ref.update(availableCommandsByInstance, (current) => {
        const next = new Map(current);
        next.set(instanceId, commands);
        return next;
      }).pipe(
        Effect.andThen(
          PubSub.publish(availableCommandsUpdates, {
            instanceId,
            commands,
          }),
        ),
        Effect.asVoid,
      );

  const getAvailableCommands: AcpRegistryRuntimeCoordinator["Service"]["getAvailableCommands"] =
    Effect.fn("AcpRegistryRuntimeCoordinator.getAvailableCommands")(function* (instanceId) {
      return Option.fromNullishOr((yield* Ref.get(availableCommandsByInstance)).get(instanceId));
    });

  const watchAvailableCommands: AcpRegistryRuntimeCoordinator["Service"]["watchAvailableCommands"] =
    (instanceId, onUpdate) =>
      Effect.scoped(
        Effect.gen(function* () {
          // Subscribe before reading the current value so a publication in
          // between is either observed from the snapshot, the queue, or both.
          const subscription = yield* PubSub.subscribe(availableCommandsUpdates);
          const current = yield* getAvailableCommands(instanceId);
          if (Option.isSome(current)) {
            yield* onUpdate(current.value);
          }
          yield* Stream.fromSubscription(subscription).pipe(
            Stream.filter((update) => update.instanceId === instanceId),
            Stream.runForEach((update) => onUpdate(update.commands)),
          );
        }),
      );

  return AcpRegistryRuntimeCoordinator.of({
    withForegroundStartup,
    runBackgroundProbe,
    clearAvailableCommands,
    publishAvailableCommands,
    getAvailableCommands,
    watchAvailableCommands,
  });
});

export const layer = Layer.effect(AcpRegistryRuntimeCoordinator, make);
