import { EnvironmentRegistry } from "@t3tools/client-runtime/connection";
import { subscribe } from "@t3tools/client-runtime/rpc";
import { type EnvironmentId, WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { emitAgentAlert } from "./agentAlertPresenter";

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    if (typeof window === "undefined") return;
    // Settings imports atoms on this runtime, so load it after runtime initialization.
    const { getClientSettings, subscribeClientSettings } = yield* Effect.promise(
      () => import("../hooks/useSettings"),
    );
    const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
    const running = yield* Ref.make(new Map<EnvironmentId, Fiber.Fiber<void, unknown>>());
    const entries = yield* Ref.make(new Map<EnvironmentId, unknown>());
    const refresh = yield* Queue.sliding<void>(1);
    const sync = Effect.fnUntraced(function* () {
      const { notificationMode, inAppNotificationsEnabled } = getClientSettings();
      const presentable = notificationMode !== "off" || inAppNotificationsEnabled;
      const active = presentable ? yield* Ref.get(entries) : new Map<EnvironmentId, unknown>();
      const current = yield* Ref.get(running);
      for (const [environmentId, fiber] of current) {
        if (active.has(environmentId)) continue;
        yield* Fiber.interrupt(fiber);
        yield* Ref.update(running, (next) => {
          const updated = new Map(next);
          updated.delete(environmentId);
          return updated;
        });
      }
      if (!presentable) return;
      for (const environmentId of active.keys()) {
        if ((yield* Ref.get(running)).has(environmentId)) continue;
        const fiber = yield* registry
          .followStream(environmentId, subscribe(WS_METHODS.serverSubscribeAgentAlerts, {}))
          .pipe(
            Stream.runForEach((alert) =>
              Effect.sync(() =>
                emitAgentAlert({
                  environmentId,
                  threadId: alert.threadId,
                  body: alert.body,
                }),
              ),
            ),
            Effect.forkScoped,
          );
        yield* Ref.update(running, (next) => {
          const updated = new Map(next);
          updated.set(environmentId, fiber);
          return updated;
        });
      }
    });
    yield* Effect.acquireRelease(
      Effect.sync(() => subscribeClientSettings(() => Queue.offerUnsafe(refresh, undefined))),
      (unsubscribe) => Effect.sync(unsubscribe),
    );
    yield* Stream.concat(
      Stream.fromEffect(SubscriptionRef.get(registry.entries)),
      SubscriptionRef.changes(registry.entries),
    ).pipe(
      Stream.runForEach((next) => Ref.set(entries, new Map(next)).pipe(Effect.andThen(sync()))),
      Effect.forkScoped,
    );
    yield* Stream.fromQueue(refresh).pipe(
      Stream.runForEach(() => sync()),
      Effect.forkScoped,
    );
  }),
);
