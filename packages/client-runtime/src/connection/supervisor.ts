import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import type { ConnectionCatalogEntry } from "./catalog.ts";
import * as Connectivity from "./connectivity.ts";
import * as ConnectionDriver from "./driver.ts";
import {
  type ConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "./model.ts";
import * as RpcSession from "../rpc/session.ts";
import * as ConnectionWakeups from "./wakeups.ts";
import type { EnvironmentSupervisorOptions } from "./supervisorModel.ts";
import { makeSupervisorRuntime } from "./supervisorRuntime.ts";
import { makeSupervisorRunLoop } from "./supervisorRunLoop.ts";

export type { EnvironmentSupervisorOptions } from "./supervisorModel.ts";

export class EnvironmentSupervisor extends Context.Service<
  EnvironmentSupervisor,
  {
    readonly target: ConnectionTarget;
    readonly state: SubscriptionRef.SubscriptionRef<SupervisorConnectionState>;
    readonly session: SubscriptionRef.SubscriptionRef<Option.Option<RpcSession.RpcSession>>;
    readonly prepared: SubscriptionRef.SubscriptionRef<Option.Option<PreparedConnection>>;
    readonly connect: Effect.Effect<void>;
    readonly disconnect: Effect.Effect<void>;
    readonly retryNow: Effect.Effect<void>;
  }
>()("@t3tools/client-runtime/connection/supervisor/EnvironmentSupervisor") {}

export const make = Effect.fn("EnvironmentSupervisor.make")(function* (
  entry: ConnectionCatalogEntry,
  options?: EnvironmentSupervisorOptions,
): Effect.fn.Return<
  EnvironmentSupervisor["Service"],
  never,
  | Connectivity.Connectivity
  | ConnectionDriver.ConnectionDriver
  | Scope.Scope
  | ConnectionWakeups.ConnectionWakeups
> {
  const runtime = yield* makeSupervisorRuntime(entry, options);
  const target = runtime.target;
  const connectivity = runtime.connectivity;
  const wakeups = runtime.wakeups;
  const targetNetwork = runtime.targetNetwork;
  const intent = runtime.intent;
  const signals = runtime.signals;
  const resetRetryState = runtime.resetRetryState;
  const state = runtime.state;
  const session = runtime.session;
  const prepared = runtime.prepared;
  const forgetSilentRoutes = runtime.forgetSilentRoutes;
  const checkBetterRoutes = runtime.checkBetterRoutes;
  const betterRouteChecks = runtime.betterRouteChecks;
  const clearLease = runtime.clearLease;
  const signal = runtime.signal;
  const { run } = makeSupervisorRunLoop(runtime);

  yield* connectivity.changes.pipe(
    Stream.runForEach((network) =>
      Ref.modify(intent, (current) => {
        const next = targetNetwork(network);
        return current.network === next
          ? [false, current]
          : ([true, { ...current, network: next }] as const);
      }).pipe(
        Effect.flatMap((changed) =>
          changed
            ? (network === "offline" ? Effect.void : forgetSilentRoutes).pipe(
                Effect.andThen(signal({ _tag: "NetworkChanged", network })),
              )
            : Effect.void,
        ),
      ),
    ),
    Effect.forkScoped,
  );
  yield* wakeups.changes.pipe(
    Stream.runForEach((reason) =>
      // A long suspension can hide a network change the platform never reported.
      (reason === "network-changed" || reason === "application-active-long"
        ? forgetSilentRoutes
        : Effect.void
      ).pipe(Effect.andThen(signal({ _tag: "Wakeup", reason }))),
    ),
    Effect.forkScoped,
  );
  yield* Queue.take(betterRouteChecks).pipe(
    Effect.flatMap(checkBetterRoutes),
    Effect.forever,
    Effect.forkScoped,
  );
  yield* run().pipe(Effect.forkScoped);

  const connect = Ref.update(intent, (current) => ({
    ...current,
    desired: true,
  })).pipe(
    Effect.andThen(signal({ _tag: "ConnectRequested" })),
    Effect.withSpan("EnvironmentSupervisor.connect"),
  );

  const disconnect = Ref.update(intent, (current) => ({
    ...current,
    desired: false,
  })).pipe(
    Effect.andThen(signal({ _tag: "DisconnectRequested" })),
    Effect.withSpan("EnvironmentSupervisor.disconnect"),
  );

  const retryNow = Ref.set(resetRetryState, true).pipe(
    Effect.andThen(signal({ _tag: "RetryRequested" })),
    Effect.withSpan("EnvironmentSupervisor.retryNow"),
  );

  yield* Effect.addFinalizer(() => Queue.shutdown(signals).pipe(Effect.andThen(clearLease)));

  return EnvironmentSupervisor.of({
    target,
    state,
    session,
    prepared,
    connect,
    disconnect,
    retryNow,
  });
});
